// Straight & Curly R1 Console — the "brain" that runs on Andrew's Mac.
//
// Read-only by design:
//   - nGage CMS: opens pages and reads their text. It never clicks Save or edits anything.
//   - Email: opens the inbox read-only over IMAP, so messages are not marked as read.
//   - Claude runs with every tool disabled (--tools ""), so it can only write text.
//
// Endpoints (all JSON):
//   GET  /health          -> { ok }
//   POST /pair  {pin}     -> { token }      (5 wrong PINs locks pairing for 15 minutes)
//   GET  /cards           -> { updatedAt, cards: [...] }        (needs token)
//   POST /ask   <audio>   -> { transcript, answer }              (needs token)

import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const HOME = homedir();
const DIR = path.join(HOME, ".snc-brain");
const CONFIG_PATH = path.join(DIR, "config.json");
const STATE_PATH = path.join(DIR, "state.json");
const PORT = Number(process.env.SNC_PORT || 8787);
const REFRESH_MINUTES = 15;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- Config & secrets ----------
const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
// config = { pin, cms: { url, pages: { label: url } }, imap: { host, port, user }, whisperModel, claudeModel, askModel }

async function keychain(service) {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-a", process.env.USER || "snc", "-s", service, "-w"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

let state = { tokens: [], snapshot: null, cards: [], updatedAt: null };
if (existsSync(STATE_PATH)) {
  try { state = Object.assign(state, JSON.parse(await readFile(STATE_PATH, "utf8"))); } catch {}
}
const saveState = () => writeFile(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });

// ---------- Claude (no tools, text only) ----------
async function claude(prompt, system, model) {
  const args = ["-p", prompt, "--tools", "", "--output-format", "json", "--model", model || "haiku", "--system-prompt", system];
  const { stdout } = await run("claude", args, { cwd: DIR, maxBuffer: 20 * 1024 * 1024, timeout: 180000 });
  const out = JSON.parse(stdout);
  return String(out.result || "").trim();
}

// ---------- nGage CMS (read-only page text) ----------
let browserCtx = null;
async function cmsContext() {
  if (browserCtx) return browserCtx;
  const { chromium } = await import("playwright");
  browserCtx = await chromium.launchPersistentContext(path.join(DIR, "browser"), { headless: true });
  return browserCtx;
}

async function signInIfNeeded(page) {
  const pw = await page.$('input[type="password"]');
  if (!pw) return false;
  const user = await keychain("snc-brain-cms-user");
  const pass = await keychain("snc-brain-cms-pass");
  if (!user || !pass) throw new Error("CMS sign-in needed but no saved login. Re-run setup.");
  // MOD Commerce CMS uses #txtUser_TextBox / #txtPass_TextBox / #btnLogin; the rest are generic fallbacks.
  const userField = await page.$('#txtUser_TextBox, input[type="email"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[type="text"]');
  if (userField) await userField.fill(user);
  await pw.fill(pass);
  const button = await page.$('#btnLogin, button[type="submit"], input[type="submit"]');
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    button ? button.click() : pw.press("Enter")
  ]);
  await page.waitForTimeout(2500);
  return true;
}

async function readCmsPages() {
  const pages = (config.cms && config.cms.pages) || {};
  const ctx = await cmsContext();
  const page = await ctx.newPage();
  const result = {};
  try {
    for (const [label, url] of Object.entries(pages)) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
        if (await signInIfNeeded(page)) await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
        const text = await page.evaluate(() => document.body.innerText);
        result[label] = text.replace(/\n{3,}/g, "\n\n").slice(0, 15000);
      } catch (e) {
        result[label] = `(Could not read this page: ${e.message})`;
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
  return result;
}

// ---------- Email (IMAP, read-only) ----------
async function readInbox() {
  if (!config.imap || !config.imap.host) return "(Email not set up)";
  const pass = await keychain("snc-brain-mail-pass");
  if (!pass) return "(Email password not saved. Re-run setup.)";
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: config.imap.host, port: config.imap.port || 993, secure: true,
    auth: { user: config.imap.user, pass }, logger: false
  });
  await client.connect();
  const lines = [];
  try {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const total = client.mailbox.exists || 0;
      if (total > 0) {
        const from = Math.max(1, total - 19);
        for await (const msg of client.fetch(`${from}:*`, { envelope: true, flags: true })) {
          const f = msg.envelope.from && msg.envelope.from[0];
          const who = f ? (f.name || f.address) : "Unknown";
          const unread = !(msg.flags && msg.flags.has("\\Seen"));
          lines.push(`${unread ? "[UNREAD] " : ""}${msg.envelope.date ? new Date(msg.envelope.date).toLocaleString("en-AU") : ""} | ${who} | ${msg.envelope.subject || "(no subject)"}`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return lines.reverse().join("\n") || "(Inbox empty)";
}

// ---------- Snapshot -> cards ----------
const CARD_SYSTEM = `You turn raw text from an online store's admin pages and an email inbox into short status cards for a tiny 240x282 pixel screen.
Return ONLY a JSON array, no prose, no code fences. Each card: {"id": string, "title": string (max 18 chars), "big": string (max 9 chars, the headline number or word), "sub": string (max 32 chars), "lines": [up to 5 strings, max 34 chars each]}.
Make these cards in this order when the data allows: "today" (sales today, total in AUD), "orders" (newest orders), "stock" (low or out of stock items), "inbox" (unread emails, sender: subject).
Use Australian formatting ($1,234.50, DD/MM). Never invent numbers: if something is missing or unclear, set "big" to "—" and say why in "sub".`;

let refreshing = null;
async function refreshSnapshot() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    log("Refreshing snapshot…");
    const [cms, inbox] = await Promise.all([
      readCmsPages().catch((e) => ({ error: e.message })),
      readInbox().catch((e) => `(Could not read email: ${e.message})`)
    ]);
    const now = new Date();
    const snapshot = { takenAt: now.toISOString(), cms, inbox };
    const raw = Object.entries(cms).map(([k, v]) => `=== CMS page: ${k} ===\n${v}`).join("\n\n") + `\n\n=== Email inbox (newest first) ===\n${inbox}`;
    let cards = state.cards;
    try {
      const out = await claude(`Current date and time in Sydney: ${now.toLocaleString("en-AU", { timeZone: "Australia/Sydney" })}\n\n${raw}`, CARD_SYSTEM, config.claudeModel || "haiku");
      const json = out.slice(out.indexOf("["), out.lastIndexOf("]") + 1);
      cards = JSON.parse(json);
    } catch (e) {
      log("Card generation failed:", e.message);
    }
    state.snapshot = snapshot;
    state.cards = cards;
    state.updatedAt = now.toISOString();
    await saveState();
    log("Snapshot done:", cards.length, "cards");
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- Voice -> text ----------
async function transcribe(buf, mime) {
  const work = path.join(tmpdir(), "snc-" + randomBytes(6).toString("hex"));
  await mkdir(work, { recursive: true });
  try {
    const ext = /mp4|aac|m4a/.test(mime) ? "m4a" : /ogg/.test(mime) ? "ogg" : /wav/.test(mime) ? "wav" : "webm";
    const input = path.join(work, "in." + ext);
    const wav = path.join(work, "in.wav");
    await writeFile(input, buf);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", wav]);
    const { stdout } = await run("whisper-cli", ["-m", config.whisperModel, "-f", wav, "-nt", "-np", "-l", "en"], { maxBuffer: 5 * 1024 * 1024, timeout: 120000 });
    return stdout.replace(/\s+/g, " ").trim();
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

const ASK_SYSTEM = `You are Claude, answering Andrew's spoken questions about his online store Straight & Curly (straightandcurly.com.au, run on the nGage CMS by MOD Commerce) on a tiny handheld screen. His answer is also read aloud.
Answer only from the store and email data provided. Be brief: 1 to 3 short sentences, plain words, no markdown, no lists unless asked. Use Australian formatting.
You are read-only: you cannot change the website, send emails or place orders. If he asks you to change something, say what you would change and that site edits aren't switched on in this version.
If the data doesn't contain the answer, say so plainly and say when the data was last updated.`;

async function answer(question) {
  if (!state.snapshot || Date.now() - Date.parse(state.updatedAt || 0) > 30 * 60000) await refreshSnapshot();
  const s = state.snapshot || { cms: {}, inbox: "(no data yet)" };
  const raw = Object.entries(s.cms || {}).map(([k, v]) => `=== CMS page: ${k} ===\n${v}`).join("\n\n") + `\n\n=== Email inbox (newest first) ===\n${s.inbox}`;
  const now = new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
  return claude(`Now in Sydney: ${now}. Data last updated: ${state.updatedAt}.\n\n${raw}\n\nAndrew asks: ${question}`, ASK_SYSTEM, config.askModel || "sonnet");
}

// ---------- Auth ----------
const attempts = [];
function pinMatches(pin) {
  const a = Buffer.from(String(pin || "").padEnd(8, "x"));
  const b = Buffer.from(String(config.pin).padEnd(8, "x"));
  return a.length === b.length && timingSafeEqual(a, b);
}
function authorised(req) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  return t && state.tokens.includes(t);
}

// ---------- HTTP ----------
function send(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, ngrok-skip-browser-warning",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store"
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too big")); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") return send(res, 204);
    if (url.pathname === "/health") return send(res, 200, { ok: true });

    if (url.pathname === "/pair" && req.method === "POST") {
      const now = Date.now();
      while (attempts.length && now - attempts[0] > 15 * 60000) attempts.shift();
      if (attempts.length >= 5) return send(res, 429, { error: "Too many tries. Wait 15 minutes." });
      const { pin } = JSON.parse((await readBody(req, 1024)).toString() || "{}");
      if (!pinMatches(pin)) { attempts.push(now); return send(res, 403, { error: "That PIN didn't work." }); }
      const token = randomBytes(32).toString("hex");
      state.tokens = [...state.tokens.slice(-4), token];
      await saveState();
      log("Paired a device");
      return send(res, 200, { token });
    }

    if (!authorised(req)) return send(res, 401, { error: "Not paired" });

    if (url.pathname === "/cards" && req.method === "GET") {
      if (!state.updatedAt) refreshSnapshot().catch(() => {});
      return send(res, 200, { updatedAt: state.updatedAt, cards: state.cards || [] });
    }

    if (url.pathname === "/ask" && req.method === "POST") {
      const audio = await readBody(req);
      const transcript = await transcribe(audio, req.headers["content-type"] || "");
      if (!transcript) return send(res, 200, { transcript: "", answer: "I didn't catch that. Hold the button and try again." });
      log("Question:", transcript);
      const a = await answer(transcript);
      return send(res, 200, { transcript, answer: a });
    }

    send(res, 404, { error: "Not found" });
  } catch (e) {
    log("Error:", e.message);
    send(res, 500, { error: "Something went wrong on the Mac." });
  }
});

server.listen(PORT, "127.0.0.1", () => log(`Brain listening on 127.0.0.1:${PORT}`));
refreshSnapshot().catch((e) => log("First snapshot failed:", e.message));
setInterval(() => refreshSnapshot().catch((e) => log("Snapshot failed:", e.message)), REFRESH_MINUTES * 60000);
