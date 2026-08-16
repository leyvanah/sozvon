# Contributing to Sozvon

Thanks for looking. Sozvon is a small, self-hosted video conferencing service
built as a fork of [Galène](https://galene.org). Contributions are welcome —
so is simply reporting that something does not work.

## Before you start: is it a Sozvon change or a Galène change?

This matters more here than in most projects. Sozvon keeps the upstream SFU core
almost untouched and merges from Galène periodically. So:

  * **A bug in the SFU core** — media routing, codecs, RTP, the client
    protocol — is almost certainly an upstream bug. Report it to
    [jech/galene](https://github.com/jech/galene); fixing it there means every
    Galène user gets the fix, and Sozvon picks it up on the next merge.
  * **A bug in what Sozvon added** — the lobby, the operator room, E2EE, login
    throttling, the redesigned web client, the Android app — belongs here.
  * **A feature that would suit Galène too** is worth offering upstream first.
    We would rather carry less fork.

[FORK-CHANGES.md](FORK-CHANGES.md) lists exactly what Sozvon changed, if you
need to check which side of the line something falls on.

Security problems go through [SECURITY.md](SECURITY.md), not the issue
tracker.

## Building and running

A single static Go binary, no CGO:

```sh
CGO_ENABLED=0 go build -ldflags='-s -w' -o sozvon .
```

To run it locally with static assets served uncached, so client edits show up
on reload:

```sh
./sozvon -dev -http :8443
```

Note that browsers only grant camera and microphone access over HTTPS or on
`localhost`. Testing from another device on your network therefore needs a
real certificate — see [galene-install.md](galene-install.md).

## Checks to run before opening a pull request

```sh
go build ./...
go vet -composites=false ./...
go test ./...
```

`-composites=false` silences unkeyed-field warnings from Pion and inherited
upstream structs; every other analyzer runs. The same checks run in CI.

The web client is plain JavaScript, type-checked through JSDoc annotations:

```sh
cd static && npx -p typescript@5 tsc -p tsconfig.json --noEmit
```

Be aware that **this check is not currently clean** — there is a backlog of
pre-existing errors, mostly from globals that are not declared to the type
checker. Compare the output before and after your change rather than expecting
zero errors, and please do not add new ones.

## Conventions

  * **Branch off `main`**, using `feat/` for features and `fix/` for fixes.
    Do not commit to `main` directly.
  * **One focused change per commit.** This is not style pedantry: small,
    self-contained commits are what makes merging upstream Galène fixes
    tractable, and what makes a Sozvon change offerable back upstream.
  * **Commit messages in English**, explaining *why* rather than restating the
    diff.
  * **Match the surrounding code.** The Go follows upstream Galène's style;
    the web client is framework-free, and stays that way.
  * When you change behaviour that [FORK-CHANGES.md](FORK-CHANGES.md)
    describes, update that file in the same commit.
  * Where Sozvon deviates from upstream inside a file that is otherwise
    upstream's, mark it — the existing code uses a trailing `(Sozvon)` in the
    comment. It makes the next merge much easier.
  * **Adding an icon?** The vendored Font Awesome webfonts are subset to the
    glyphs the client actually uses — the full face is 154 KB for under thirty
    icons, and being woff2 it is already compressed, so the server's gzip does
    nothing for it. A new icon renders as **nothing**, or as a box with its own
    hex code in it, until the subset is regenerated. This applies to both ways
    of asking for one: an `fa-something` class in the markup, and a
    `content: "\fXXX"` printed by a stylesheet.

    ```sh
    python contrib/subset-fontawesome.py --source path/to/pristine/webfonts
    ```

    The script's header explains where to get pristine fonts (they are in this
    repository's history). It refuses names Font Awesome does not define and
    private-use codepoints it does not carry, which catches the usual typo and
    an icon renamed between releases. The failure mode without it is silent,
    so this is worth remembering.

## Licence

Sozvon is MIT, the same as Galène, and the original copyright of Juliusz
Chroboczek is retained in full. By contributing you agree that your
contribution is licensed under the same terms; see [LICENCE](LICENCE).
