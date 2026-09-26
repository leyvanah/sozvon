# Browser tests

Two clients join a real room through the real login screen, in one Chromium
with a synthetic camera (rolling colour bars) and microphone (a beep), against
a server built from this tree. The tests read what each side actually gets:
decoded frames, tiles, labels, the sender's bitrate cap.

They run in CI on every pull request (the `Browser tests` job), and locally:

```sh
cd test/browser && npm ci && npx playwright install chromium && cd ../..
test/browser/run.sh                  # the whole suite, about six minutes
test/browser/run.sh smoke tile-mic   # some specs
test/browser/run.sh --repeat-each=5 quality
```

`run.sh` builds the server, starts it on port 18443 (`SOZVON_TEST_PORT`) with
the rooms in `groups/` and a throwaway data directory, runs Playwright, and
stops the server. Any Playwright arguments pass through.

Against a server you already run instead: `SOZVON_URL=http://localhost:8443
npx playwright test` from this directory, with the two rooms from `groups/`
installed there.

On failure Playwright keeps a screenshot and a trace under `test-results/`
(CI uploads them as an artifact); `npx playwright show-trace
test-results/*/trace.zip` replays the run frame by frame.

## Nothing passes without running

- A run where no test executed is a failure: Playwright exits 0 when every
  test was skipped, and `run.sh` refuses to call that a pass.
- Skips are listed with their reasons, never folded into "passed". In CI
  (`SOZVON_FAIL_ON_SKIP=1`) a skip fails the job.
- The only skip left in the suite is `bitrate.spec.js` on a receiver that
  still cannot play audio on time 45 s into a quiet call.

## The specs

| Spec | What it checks |
| --- | --- |
| `smoke` | Both clients reach the call through the pre-join device check; exactly two tiles each (a third means one published twice, which has shipped before); **video decodes on both sides** — `videoWidth > 0` and the frame counter advances, so a frozen or black incoming stream fails here and nowhere else; the participant list; chat both ways, with `<b>markup</b>` arriving as text; no page errors. |
| `reconnect` | A TCP proxy between one client and the server freezes the signalling path for 75 s mid-call while media keeps flowing (the 2026-09-21 production drop): the client ends up back in the call, publishing its camera, without a click. Then the same drop in a two-person E2EE room, where the rejoin is refused while the dead session still holds a seat, and must be retried. About four minutes of the run. |
| `videoless` | Camera off mid-call: the other side shows the avatar in the list colour and the name instead of the empty video; camera on: the picture replaces it. |
| `tile-mic` | Muting marks the tile on the other side, unmuting clears it, rejoining without a microphone is marked from the start. |
| `quality` | 20% extra packet loss is reported through a wrapped `getStats` in one client; everything after that runs for real. The tile shows the translated indicator, recovery hides it, no toasts at any point. |
| `bitrate` | Lag is added to the receiver's audio jitter-buffer delay through `getStats`: a new stream starts at the start cap, the lag lowers the sender's real `maxBitrate`, recovery raises it. `SOZVON_FULL_BITRATE=1` also waits for the cap to lift entirely (two minutes more). |

`manual/` holds drivers for checks a person watches on a real device (a phone
watching a call while a scripted participant turns the camera off and on). They
wait for marker files and only run with `STEP_DIR` set.

## Rules for the harness

- Wait for state, never sleep and sample. A fixed wait followed by an
  assertion is what made `quality` fail pushes on a busy machine: at second
  seven the call really was degraded, and the indicator was right to say so.
- `chooseDevices()` in `lib.js` waits until each pre-join toggle is really on.
  Clicking the microphone and then Join at once goes in without the
  microphone (the toggle turns on only when `getUserMedia` returns); on a busy
  machine that made a third of `tile-mic` runs fail, correctly.
- Every spec closes all browser contexts in `afterEach`: a failed test
  otherwise leaves participants in the shared `smoke` room and breaks the
  next one.
- Break what a new test covers and confirm it goes red. Making remote video
  freeze (pausing incoming media in `galene.js`) turns `smoke` red with
  `alice: media-1 is frozen — no frames decoded in the sample window`. A green
  test that cannot fail is worse than none, because it is counted.
- Check a change to the harness under load, not only on an idle machine:
  every core busy (eight `for(;;){}` Node processes on an 8-core laptop) is
  what found the problems above.
