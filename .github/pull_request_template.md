<!--
  Thanks for the pull request.  A few things that make review quick:
  see CONTRIBUTING.md for the full version.
-->

## What this changes

<!-- What it does and, more importantly, why. -->

## Why here and not upstream

<!--
  Sozvon keeps the SFU core close to upstream Galène.  If this touches shared
  core code, say why it belongs in the fork rather than in jech/galene.
  Delete this section if the change is clearly Sozvon's own (lobby, operator
  room, E2EE, authlimit, the web client's interface, the Android app).
-->

## Checks

- [ ] `go build ./...`
- [ ] `go vet -composites=false ./...`
- [ ] `go test ./...`
- [ ] For web client changes: `tsc` adds no new errors (the baseline is not clean)
- [ ] Tried it in a real call, if the change can affect one
- [ ] [FORK-CHANGES.md](../blob/main/FORK-CHANGES.md) updated, if this changes behaviour it describes

## Anything reviewers should know

<!-- Trade-offs you made, things you were unsure about, what you did not test. -->
