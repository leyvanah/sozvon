**English** · [Русский](README.ru.md)

# Sozvon Desktop

The desktop app for Sozvon, a self-hosted WebRTC video conferencing service
(a fork of [Galène](https://galene.org)). It lives in the same repository as
the server, next to [android/](../android/README.md).

The build targets Windows (an NSIS installer). Electron is cross-platform, but
macOS and Linux targets have not been added yet.

An Electron app: a window onto the Sozvon web client, a launcher for picking a
server and a room, and a wizard that deploys Sozvon to your VPS over SSH if you
do not have a server yet.

## Deploying a server from the app

The start screen has a "Deploy your own on a VPS" link. The wizard asks for the
server's address, SSH access (password or key) and a TLS mode, then installs
Sozvon on a clean Debian/Ubuntu.

How it works, which matters for knowing where responsibility lies:

- The app does **not** implement the installation itself. It uploads
  `resources/install.sh` to the server — the same script a person runs by hand
  from the Sozvon repository — and runs it. The installation logic lives in one
  place and is tested separately from the app.
- The installation runs as a **detached process** on the server. The app polls
  `/var/lib/sozvon-install/state.json` instead of holding an SSH session open,
  so a dropped connection (the laptop lid closed, the network changed) does not
  interrupt the install — the app reconnects and carries on watching.
- **The host key is checked explicitly.** On first connection the fingerprint
  is shown; a changed key is shown as a separate warning, with the old value.
  Silently accepting a key is not an option: whoever sits in the middle of the
  connection would get root on your server.
- **The SSH password is never stored.** It is needed only for the duration of
  the install; after that the app talks to the server over HTTPS. The operator
  password reaches the installer through an environment variable, not the
  command line — `/proc/<pid>/cmdline` is readable by every user on the system.

TLS modes (all three are available):

| Mode | What it does | When you need it |
|---|---|---|
| sslip.io + Let's Encrypt | The name is derived from the server's IP; the certificate is real | No domain, but it has to work in a browser |
| Own domain | The domain's A record points at the server | You have a domain; the option with no third-party services |
| Self-signed | The certificate is generated on the spot | Neither a domain nor access to Let's Encrypt. Browsers will refuse — only the app will work |

The installer is **not duplicated**: the single source is `contrib/install.sh`
at the repository root. `npm start` and `npm run dist` first run
`scripts/sync-installer.js`, which copies it into `resources/` (where
electron-builder picks it up); the copy is not kept in git. When running from
source the copy may be missing — the app then reads `contrib/install.sh`
directly.

## On duty in the tray, knocks above other windows

The app assumes the operator is busy with something else while waiting for
clients. (The app's own interface — launcher, tray — is in Russian for now;
the labels below are translated. The web client inside it speaks both.)

- **The close button hides the window in the tray** instead of quitting. The
  tray icon's menu answers the one question that matters — would I hear a
  knock right now ("On duty" / "Not on duty" / "Knocking: N") — and holds two
  settings: "Minimise to tray" and "Start with Windows" (starting straight into
  the tray). "Quit Sozvon", to really leave, is there too.
- **Being on duty means having the operator room open.** While the operator
  dashboard is open in the app (even with the window hidden in the tray), it
  polls the child rooms every 3 seconds. The app learns which group is the
  operator room from the client itself and remembers it per server, so
  "Go on duty" in the tray works even after the window has gone elsewhere.
- **A knock is shown in a window above all others** — in the bottom-right
  corner, above full-screen video, without taking the keyboard. The buttons are
  the client's own: from the operator room, "Admit & join" (the app window comes
  forward straight into the room); inside a room, "Admit" / "Deny". The
  notification is visible only while the app is not the window in front,
  disappears once the knock is resolved anywhere (a phone included), and does
  not come back once closed with its × button.

Not yet: showing knocks at *other* rooms while the operator is already in a
call — that needs a separate background connection to the operator room.

What a knock says and which buttons it has is decided by the web client
(`hostKnock` in `static/galene.js`): it sends a ready, translated sentence and
a list of buttons; the app only draws them and reports which one was pressed.

To work on the notification window without a server:
`SOZVON_KNOCK_DEMO=1 npm start` shows a sample knock three seconds in.

## Development

Requires Node.js 20+.

```sh
npm install
npm start
```

## Building the installer

```sh
npm run dist
```

The result is in `dist/`.

On Windows without the right to create symbolic links, electron-builder fails
unpacking its `winCodeSign` tools (the archive carries macOS symlinks). Extract
the archive from `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` into a
folder named `winCodeSign-2.6.0` next to it once, ignoring the two symlink
errors, and the build goes through.

## Configuration

Stored in `%APPDATA%/sozvon-desktop/config.json` and edited from the start
screen and the tray menu. Fields:

- `servers` — saved servers, one object per server:
  `{"url": "…", "name": "Clinic", "hub": "…", "lastGroup": "…", "rooms": ["…"]}`.
  The start screen keeps the list: a server lands here when you connect to it
  and when the wizard deploys it, most recent first (at most 20). A deployed
  server is **added**, not written over the previous one. `hub` is the
  server's operator room, as reported by the client.
- `serverUrl` — the base URL of a Sozvon server, e.g.
  `https://sozvon.example.com:8443`. Duplicates the first entry of `servers`;
  kept for configs written by earlier builds.
- `lastGroup` — the name of the last room opened.
- `recentGroups` — recent rooms of the first server in `servers` (the room
  lists themselves live inside the `servers` entries, one per server).
- `theme` — `system`, `light` or `dark`, as chosen in the web client.
- `minimizeToTray` — the close button hides the window in the tray (default
  on).
- `autoStart` — start with Windows, straight into the tray (default off).
- `knownHosts` — accepted SSH host keys, `"host:port": "SHA256:…"`. Delete an
  entry to make the app ask again.
- `pinnedCerts` — pinned TLS certificates, `"host": "<sha256 hex>"`. Filled in
  automatically when deploying with a self-signed certificate. For such a host
  the app accepts **only** that certificate and rejects a changed one.
- `allowInsecureCerts` — an emergency bypass: accept any certificate for hosts
  that have **no** pin. Unsafe; kept for manual debugging. Changing it restarts
  the app.

## Testing a deployment without building the app

The deployment logic is in `src/deploy/deployer.js` and does not depend on
Electron, so it can be run with plain Node against a throwaway server:

```sh
node scripts/test-deploy.js --host 203.0.113.10 --password ... --tls self-signed
```

## Licence

MIT.
