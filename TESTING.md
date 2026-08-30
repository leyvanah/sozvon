# Testing Sozvon

How this project is tested, what is covered automatically, what has to be
checked by hand, and where the gaps are.

Sozvon is a fork of [Galène](https://galene.org). Upstream's tests cover the
SFU core — packet handling, jitter, codecs, tokens. Almost everything this fork
adds sits *around* that core: the waiting room, the operator room, per-group
end-to-end encryption, the login throttle, the localised web client. This file
is about testing the fork's part.

## Running the tests

Everything below runs with no dependencies beyond the Go toolchain and Node,
and takes well under a minute.

```sh
go build ./...
go vet -composites=false ./...
go test ./...
node --test 'static/test/*.test.js'
```

`-composites=false` silences unkeyed-field warnings from Pion and inherited
upstream structs; every other analyzer runs.

The web client is also type-checked through its JSDoc annotations:

```sh
cd static && npx -p typescript@5 tsc -p tsconfig.json --noEmit
```

**This check is not clean** — there is a backlog of pre-existing errors, mostly
undeclared globals. Compare the output before and after a change rather than
expecting zero, and do not add new ones.

CI runs all of the above on every pull request, plus a race-detector build, a
`govulncheck` scan, a `gitleaks` sweep of the full history, and a `dash -n`
parse of the installer.

## The levels, and what belongs at each

**Go unit tests**, next to the code. Pure logic with no I/O: parsing, name
handling, the throttle's delay curve. Fast, and the first place to add a test.

**Go protocol tests** — [webserver/protocol_test.go](webserver/protocol_test.go).
These boot a real server and drive a real websocket, so they cover the whole
path a browser takes: `webserver` → `rtpconn` → `group`. This is where the
fork's behaviour actually lives, because features like the waiting room are
decisions split across all three packages — a unit test of `group.AddClient`
would not notice that `rtpconn` stopped forwarding the knock. They stop short
of opening a peer connection: media is upstream's code and needs a real WebRTC
stack.

**Client unit tests** — [static/test/](static/test/), run by Node's own test
runner. For the parts of the web client that are pure functions: the E2EE
crypto core, the localisation tables. No framework, no `package.json`, no
`node_modules`.

**Browser harnesses**, run by hand. [static/e2ee-test.html](static/e2ee-test.html)
runs both sides of the E2EE handshake in one page and shows the emoji SAS.

**Manual checks**. Everything involving a camera, a real browser layout, or a
phone. The checklist below.

## What is covered automatically

| Area | Where | What it pins |
| --- | --- | --- |
| Waiting room | `webserver/protocol_test.go` | knock → operator notified → admit → re-join; deny; a denial is not an admission; a lobby with no operator refuses instead of parking the guest; only an operator may admit |
| Operator room | `webserver/protocol_test.go` | a child room forces the lobby and is not itself a hub; a child is unreachable without the personal link; the hub advertises itself; the dashboard's subgroup listing |
| Per-group E2EE | `webserver/protocol_test.go` | the policy reaches the client in the group status; `require-e2ee` turns away the third participant; without it there is no cap |
| E2EE crypto | `static/test/e2ee-crypto.test.js` | both peers derive the same SAS; a man in the middle produces *different* SAS on the two legs; frame round-trip for audio, delta and key frames; the clear codec prefix is exactly what the SFU parses and is authenticated against tampering; each sender gets a distinct key; the 48-bit frame counter round-trips; chat round-trip, fresh IV per message, keys do not cross calls |
| Login throttle | `authlimit/authlimit_test.go`, `webserver/protocol_test.go` | the delay curve and ban window as units; that the join path is wired to them |
| Localisation | `static/test/i18n.test.js` | English and Russian define the same keys; every key used in markup or scripts exists; placeholders survive translation |
| Static compression | `webserver/compress_test.go` | `q=0` is a refusal; only text types above the size floor are compressed; the compressed representation gets its own ETag; `Vary` is always set; a range is dropped rather than served wrong; a 304 is not announced as gzipped; end-to-end, the bytes a browser gets decompress to the file |
| Health endpoint | `webserver/protocol_test.go` | `/healthz` answers — the deploy script's rollback check depends on it |

A note on trusting this table: each of these was checked against a deliberate
break in the code it covers, and fails when the behaviour is removed. That pass
found one test that had looked fine and proved nothing (a knocking client
cannot self-admit — it was refused a step earlier, for an unrelated reason).
**When adding a test here, break the thing it covers and confirm it goes red.**
A green test that cannot fail is worse than no test, because it is counted.

## What is not covered, and what that costs

- **The web client's behaviour.** `static/galene.js` is ~8700 lines and is
  where most of the fork's work went — the video layout, the people and chat
  panes, the settings drawer, the pre-join device check. Nothing exercises it.
  This is the largest gap; browser tests are the next step (see below).
- **Media.** Nothing sends a frame end to end. Whether video actually arrives,
  encrypted or not, is only ever established by two real browsers. The
  recurring E2EE keyframe bug lives here.
- **The Android app.** `android/` has no `test/` or `androidTest/` directory;
  CI compiles it and nothing more.
- **The desktop app.** CI syntax-checks the sources and confirms the deployer
  can find the installer. The deploy logic itself is untested.
- **The installer.** `contrib/install.sh` is checked only for parsing under
  `dash`. Whether it installs is established by running it on a throwaway
  container or VPS.
- **Theming.** The private deployment theme is applied at deploy time and is
  not in this repository, so nothing here can test it.

## Manual checklist

Automated tests do not touch the browser, so this is not optional.

### Before every deploy (about ten minutes, one machine, two browser windows)

Use two windows — one normal, one private — so they are separate clients.

1. **Join.** Open a room, allow camera and microphone at the pre-join check;
   the preview shows video and the level meter moves. Connect.
2. **Two participants.** Join from the second window. Each sees the other's
   video and hears the other. Check both directions — one-way video is the
   fork's most frequent failure.
3. **Chat.** Send a message each way. Check a message with an emoji and one
   with `<b>markup</b>` (it must appear as text).
4. **Controls.** Mute and unmute; camera off and on; both reflected in the
   other window.
5. **Waiting room.** In a lobby group, join as a guest from the second window:
   the guest waits, the operator sees the knock. Admit — the guest gets in.
   Repeat and deny — the guest is told, and does not get in.
6. **Language.** Switch EN ⇄ RU. The whole interface changes, including the
   waiting room and any open dialog. No raw keys like `toast.noMedia`.
7. **Theme.** Switch light ⇄ dark. Check the video area, the chat pane and the
   settings drawer; look for text on same-colour background and for links.
8. **Layout.** Narrow the window to phone width. Controls stay reachable, the
   video grid reflows, nothing overflows horizontally.
9. **Reload.** Refresh mid-call. The client reconnects and media resumes.

### For an E2EE group, additionally

10. Both windows show the encryption indicator and **the same emoji**.
11. Video flows in both directions — this is where the keyframe bug appears, as
    one side black while the other is fine.
12. Chat still works.
13. A third participant is refused (in a `require-e2ee` group).

### Before a release, additionally

14. **A real phone**, on a real network, joining a real server. The LAN test
    stand does not exercise the paths a phone does.
15. **The APK**: install, join, camera and microphone permissions, screen
    rotation, sending a file.
16. **The installer** on a throwaway VPS or container: install, join a room,
    uninstall, `--purge`.
17. **TLS**: whichever of the three certificate paths the release touched.

Record anything found but not fixed in [KNOWN-BUGS.md](KNOWN-BUGS.md).

## Where to take this next

In order of value per hour spent. The first costs nothing but the time; the
second is the only one that adds a dependency, and is written up as a decision
rather than a task for that reason.

1. **Grow the client's testable surface without a browser.** Most of
   `galene.js` cannot be unit-tested because it reaches for the DOM, but a good
   deal of what breaks in it is pure: the label a tile derives for a
   participant, the mute state read back from user data, the grid geometry, the
   settings round-trip, the panel's open/closed state across the 1024 px
   breakpoint — a real, shipped bug that a five-line function would have
   pinned. Each time such logic is *already* being touched, lift it into a
   small module and cover it under `static/test/` with `node --test`, which is
   set up and needs no `package.json`. No dependency, no CI time, and the
   largest gap becomes a shrinking one.

2. **One browser smoke test.** Playwright driving two Chromium instances
   against a `-dev` server with `--use-fake-device-for-media-stream` — two
   clients join, see each other's video both ways, exchange chat — would cover
   more of the fork than everything above put together, and would catch most of
   what the checklist's steps 1–5 look for, in about thirty seconds. The cost
   is worth stating plainly: one dev dependency, a lockfile, a browser download
   cached in CI, a couple of minutes per run.

   It has two forms, and they are not the same decision:
   - **Local only** — an ignored `test/browser/` invoked with `npx playwright`,
     run before a deploy in place of the first half of the checklist. Nothing
     is added to the repository or to CI, and the check exists as soon as it is
     written.
   - **In CI** — the same spec wired into the workflow, so it guards pull
     requests as well as deploys. That is what turns it from a convenience into
     coverage.

   Starting local and promoting it once it has proved itself over a few real
   deploys is the cheap order.

3. **A second protocol-test tranche**: token-based invites into an operator
   room, the 1-on-1 lock, `setgroup` and `deletetoken`, the group status seen by
   an unauthenticated client.

4. **Installer tests in CI** — run `install.sh` in a container and assert the
   service comes up and `/healthz` answers. Three of the four open installer
   bugs in KNOWN-BUGS.md would have been caught by it.

5. **Android instrumentation**, at least for the WebView permission bridge,
   which is where the file-picker and camera bugs have been.
