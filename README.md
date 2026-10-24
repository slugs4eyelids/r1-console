# S&C Console for Rabbit R1

A Rabbit R1 creation for Straight & Curly: sales, orders, stock and inbox cards, and "hold to ask Claude".

- `index.html`, `icon.png`: the creation, served by GitHub Pages.
- `brain/`: the read-only service that runs on the Mac. Set it up with:

```
git clone https://github.com/slugs4eyelids/r1-console.git ~/Documents/r1-console
bash ~/Documents/r1-console/brain/setup.sh
```

Setup stores passwords in the macOS Keychain, starts the brain at login, and shows the QR code to scan on the R1 (creations card → add via QR code).
To remove: delete the creation on the R1, then run
`launchctl bootout gui/$(id -u)/au.straightandcurly.brain; launchctl bootout gui/$(id -u)/au.straightandcurly.tunnel`
and delete `~/Library/LaunchAgents/au.straightandcurly.*.plist` and `~/.snc-brain`.
