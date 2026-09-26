# Testing Sozvon

How this project is tested: what is covered automatically, and what has to be
checked by hand.

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
`govulncheck` scan, a `gitleaks` sweep of the full history, a `dash -n`
parse of the installer, and the browser tests below.

### Browser tests

Two real clients in one Chromium, with a synthetic camera and microphone,
against a server built from the tree. They need Playwright, and take about six
minutes:

```sh
cd test/browser && npm ci && npx playwright install chromium && cd ../..
test/browser/run.sh                    # everything
test/browser/run.sh smoke              # one spec
```

`run.sh` builds the server, starts it on port 18443 with the rooms in
`test/browser/groups/`, runs the suite and stops the server. See
[test/browser/README.md](test/browser/README.md).

## Running them automatically before a push

A push here leads to two things that are awkward to undo: a public repository
and, shortly after, a deploy. Thirty seconds of checks beforehand is cheaper
than either. Git will run them for you — `.git/hooks/pre-push` is not tracked,
so each clone opts in:

```sh
cat > .git/hooks/pre-push <<'HOOK'
#!/bin/sh
[ -n "$SKIP_TESTS" ] && exit 0
root=$(git rev-parse --show-toplevel) && cd "$root" || exit 1
CGO_ENABLED=0 go vet -composites=false ./... || exit 1
CGO_ENABLED=0 go test ./... || exit 1
command -v node >/dev/null 2>&1 && { node --test 'static/test/*.test.js' || exit 1; }
exit 0
HOOK
chmod +x .git/hooks/pre-push
```

`SKIP_TESTS=1 git push` skips it deliberately. Prefer that to `--no-verify`,
which turns off *every* hook — including any guard a clone has against pushing
something it should not.

A hook is a convenience, not the gate: CI runs the same checks on the pull
request, and is the thing that actually has to be green.

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

**Browser tests** — [test/browser/](test/browser/), Playwright. Two clients
join a real room through the real login screen and pre-join device check, and
the tests read what each side actually gets: decoded video frames, tiles,
labels, the sender's bitrate cap. For behaviour that only exists once two
browsers hold a call. Slow, so only for what the levels above cannot reach.

**Browser harnesses**, run by hand. [static/e2ee-test.html](static/e2ee-test.html)
runs both sides of the E2EE handshake in one page and shows the emoji SAS.

**Manual checks**. Everything involving a camera, a real browser layout, or a
phone, against a written protocol kept outside the repository — see the last
section.

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
| A call, both ways | `test/browser/smoke.spec.js` | two clients each get exactly two tiles; video frames decode on **both** sides; the participant list; chat both ways, markup arriving as text; no page errors |
| Reconnection | `test/browser/reconnect.spec.js` | a minute-long signalling stall mid-call ends back in the call, camera published again without a click; a rejoin refused because the dead session still holds a seat in a two-person E2EE room is retried |
| Camera off | `test/browser/videoless.spec.js` | the other side shows the avatar and name instead of an empty video, and the picture again when the camera comes back |
| Silent microphone | `test/browser/tile-mic.spec.js` | muting marks the tile on the other side, unmuting clears it, joining without a microphone is marked from the start |
| Call quality | `test/browser/quality.spec.js` | injected packet loss shows the translated indicator on the right tile, recovery hides it, no toasts |
| Adaptive bitrate | `test/browser/bitrate.spec.js` | a new stream starts at the start cap; lag at the receiver lowers the sender's real `maxBitrate`, recovery raises it |

A note on trusting this table: each of these was checked against a deliberate
break in the code it covers, and fails when the behaviour is removed. That pass
found one test that had looked fine and proved nothing (a knocking client
cannot self-admit — it was refused a step earlier, for an unrelated reason).
**When adding a test here, break the thing it covers and confirm it goes red.**
A green test that cannot fail is worse than no test, because it is counted.
Of the browser rows, the smoke test has been through that pass (freezing
incoming video turns it red); the others have not yet been checked that way.

## The manual half

The browser tests hold a call but do not look at it, and they use a synthetic
camera, so a good deal of what this fork does — how the video stage and the
panes look, themes, real devices, phones — is checked by hand against a
written protocol before a deploy.

That protocol, the inventory of what it exists to catch, and the plan for what
to automate next are **kept out of this repository**, in a local
`TEST-PROTOCOLS.local.md` beside the pre-push hook that runs the automated
half. They are working notes for whoever is holding the machine, they name
deployment specifics, and an exact list of where a product is thin is not a
thing to publish while it is thin.

If you are running Sozvon yourself, the short version is: before you deploy,
have two browser windows join a real room and check that audio and video
arrive **in both directions** — one-way media is this fork's most frequent
failure, and it looks fine from the sending side.
