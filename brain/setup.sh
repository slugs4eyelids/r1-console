#!/bin/bash
# Straight & Curly R1 Console — one-time setup on the Mac.
# Run from this folder:   bash setup.sh
# Passwords you type here go straight into your Mac's Keychain. They are never shown or sent anywhere else.

set -e
cd "$(dirname "$0")"
BRAIN_DIR="$(pwd)"
DATA="$HOME/.snc-brain"
mkdir -p "$DATA/models"
chmod 700 "$DATA"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ask()  { local p="$1" d="$2" v; read -r -p "$p${d:+ [$d]}: " v; echo "${v:-$d}"; }
secret() { local p="$1" v; read -r -s -p "$p: " v; echo >&2; echo "$v"; }
keep() { security add-generic-password -U -a "$USER" -s "$1" -w "$2" >/dev/null; }

bold "1/7  Checking tools"
if ! command -v brew >/dev/null; then
  echo "Homebrew is needed. Install it from https://brew.sh, then run this again."; exit 1
fi
for f in node ffmpeg whisper-cpp qrencode; do
  brew list "$f" >/dev/null 2>&1 || brew install "$f"
done
brew list --cask ngrok >/dev/null 2>&1 || brew install --cask ngrok

if ! command -v claude >/dev/null; then
  echo "Claude Code isn't installed yet. Run this, sign in with your Claude account, then run setup again:"
  echo "  curl -fsSL https://claude.ai/install.sh | bash && claude"
  exit 1
fi
echo "Testing Claude…"
claude -p "Reply with just: ok" --tools "" --model haiku --output-format text || {
  echo "Claude didn't answer. Open Terminal, run 'claude' once to sign in, then run setup again."; exit 1; }

bold "2/7  Installing the brain"
npm install --omit=dev --no-audit --no-fund
npx playwright install chromium

MODEL="$DATA/models/ggml-base.en.bin"
if [ ! -f "$MODEL" ]; then
  echo "Downloading the speech model (about 140 MB)…"
  curl -L --fail -o "$MODEL" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
fi

bold "3/7  nGage CMS (read-only)"
echo "Open each page in your browser and paste its address."
echo "Sign in to the CMS in your browser first, then copy the address of each page from the address bar."
CMS_LOGIN=$(ask "CMS sign-in page address" "https://cms.savoysalonsupplies.com/login/")
CMS_ORDERS=$(ask "Orders page address")
CMS_SALES=$(ask "Sales report or dashboard page address (Enter to skip)")
CMS_STOCK=$(ask "Stock page address (Enter to skip)")
CMS_USER=$(ask "CMS username or email")
CMS_PASS=$(secret "CMS password (hidden)")
keep snc-brain-cms-user "$CMS_USER"
keep snc-brain-cms-pass "$CMS_PASS"
unset CMS_PASS

bold "4/7  Email (read-only, nothing gets marked as read)"
MAIL_USER=$(ask "Email address" "support@straightandcurly.com.au")
DEFAULT_IMAP=""
for h in mail.ngage.software webmail.ngage.software imap.ngage.software; do
  if nc -z -G 3 "$h" 993 2>/dev/null; then DEFAULT_IMAP="$h"; break; fi
done
[ -z "$DEFAULT_IMAP" ] && echo "Couldn't find the mail server automatically. Check webmail's settings or ask MOD for the IMAP server."
IMAP_HOST=$(ask "Incoming mail (IMAP) server" "$DEFAULT_IMAP")
MAIL_PASS=$(secret "Email password (hidden)")
keep snc-brain-mail-pass "$MAIL_PASS"
unset MAIL_PASS

bold "5/7  PIN for the R1"
while true; do
  PIN=$(ask "Choose a 4-digit PIN")
  [[ "$PIN" =~ ^[0-9]{4}$ ]] && break
  echo "Use exactly 4 digits."
done

bold "6/7  Secure link (ngrok)"
echo "1. Sign up free at https://dashboard.ngrok.com/signup"
echo "2. Copy your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken"
echo "3. Copy your free domain from https://dashboard.ngrok.com/domains (looks like something.ngrok-free.app)"
NGROK_TOKEN=$(secret "ngrok authtoken (hidden)")
ngrok config add-authtoken "$NGROK_TOKEN" >/dev/null
unset NGROK_TOKEN
NGROK_DOMAIN=$(ask "ngrok domain")
NGROK_DOMAIN="${NGROK_DOMAIN#https://}"; NGROK_DOMAIN="${NGROK_DOMAIN%/}"
PAGES=$(ask "Creation address (GitHub Pages)" "https://slugs4eyelids.github.io/r1-console/")
PAGES="${PAGES%/}/"

# Write config (no passwords in here)
node -e '
const [pin, login, orders, sales, stock, mailUser, imapHost, model, domain, pages] = process.argv.slice(1);
const p = {};
if (orders) p.orders = orders;
if (sales) p.sales = sales;
if (stock) p.stock = stock;
const cfg = { pin, cms: { login, pages: p }, imap: mailUser ? { host: imapHost, port: 993, user: mailUser } : null,
  whisperModel: model, claudeModel: "haiku", askModel: "sonnet", ngrokDomain: domain, pagesUrl: pages };
require("fs").writeFileSync(process.env.HOME + "/.snc-brain/config.json", JSON.stringify(cfg, null, 2), { mode: 0o600 });
' "$PIN" "$CMS_LOGIN" "$CMS_ORDERS" "$CMS_SALES" "$CMS_STOCK" "$MAIL_USER" "$IMAP_HOST" "$MODEL" "$NGROK_DOMAIN" "$PAGES"

bold "7/7  Starting it up (and keeping it running)"
NODE_BIN="$(command -v node)"
NGROK_BIN="$(command -v ngrok)"
CLAUDE_DIR="$(dirname "$(command -v claude)")"
BREW_BIN="$(brew --prefix)/bin"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS"

cat > "$AGENTS/au.straightandcurly.brain.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>au.straightandcurly.brain</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>$NODE_BIN</string><string>$BRAIN_DIR/brain.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$BRAIN_DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$CLAUDE_DIR:$BREW_BIN:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>USER</key><string>$USER</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA/brain.log</string>
  <key>StandardErrorPath</key><string>$DATA/brain.log</string>
</dict></plist>
PLIST

cat > "$AGENTS/au.straightandcurly.tunnel.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>au.straightandcurly.tunnel</string>
  <key>ProgramArguments</key><array>
    <string>$NGROK_BIN</string><string>http</string><string>--url=https://$NGROK_DOMAIN</string><string>8787</string><string>--log=stdout</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA/tunnel.log</string>
  <key>StandardErrorPath</key><string>$DATA/tunnel.log</string>
</dict></plist>
PLIST

for L in brain tunnel; do
  launchctl bootout "gui/$(id -u)/au.straightandcurly.$L" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/au.straightandcurly.$L.plist"
done

sleep 4
if curl -fsS "https://$NGROK_DOMAIN/health" -H "ngrok-skip-browser-warning: 1" >/dev/null; then
  echo "The brain is running and reachable."
else
  echo "Not reachable yet. Check $DATA/brain.log and $DATA/tunnel.log."
fi

# Install QR for the R1 (creations card -> add via QR code)
APP_URL="${PAGES}?api=https://$NGROK_DOMAIN"
QR_JSON=$(node -e 'console.log(JSON.stringify({title:"S&C Console",url:process.argv[1],description:"Straight & Curly sales, orders, stock and inbox. Hold the side button to ask Claude.",iconUrl:process.argv[2]+"icon.png",themeColor:"#EB0C00"}))' "$APP_URL" "$PAGES")
qrencode -s 10 -m 2 -o "$DATA/install-qr.png" "$QR_JSON"
bold "Done. Scan this with your R1: creations card → add via QR code"
qrencode -t ANSIUTF8 "$QR_JSON"
open "$DATA/install-qr.png"
