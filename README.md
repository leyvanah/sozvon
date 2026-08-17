**English** · [Русский](README.ru.md)

# Sozvon

Sozvon is a self-hosted video conferencing service, built as a fork of
[Galène](https://galene.org) — the lightweight WebRTC SFU by Juliusz
Chroboczek ([github.com/jech/galene](https://github.com/jech/galene)).

## Relationship to Galène

Sozvon is a downstream fork and owes all of its core to the Galène project.
It follows Galène upstream and layers its own features and interface on top.

The WebRTC SFU core — media routing, codecs, RTP handling — is largely
unchanged from upstream; the fork's changes are concentrated in the web
client, plus a handful of additive, self-contained server-side features
(lobby, operator room, login throttling, E2EE). As a rough sense of scale,
about 40% of the files in this repository have been added or modified since
the fork point (upstream commit `ba29f3d`; upstream is merged in
periodically, most recently through `9e03b36`), the large majority of it in
`static/` (the web client) and a new `android/` app that has no upstream
equivalent at all. See [FORK-CHANGES.md](FORK-CHANGES.md) for the complete,
itemized diff.

The upstream documentation in this repository still applies:

  * [galene-install.md](galene-install.md): installation instructions
  * [galene.md](galene.md): usage and administration
  * [galene-client.md](galene-client.md): writing clients
  * [galene-protocol.md](galene-protocol.md): the client protocol
  * [galene-api.md](galene-api.md): the administrative API

## Added in Sozvon

  * **Lobby / waiting room** — a guest opens a normal group link, enters only
    a display name, and is placed in a waiting room; an operator admits or
    denies each request. Invite tokens bypass the lobby. (server + web client)
  * **Operator room** — a dedicated group becomes an operator dashboard that
    issues personal, revocable invite links per client, each opening into its
    own gated child room with a live idle/knocking/in-call status.
  * **End-to-end encryption** — opt-in per group. Two participants encrypt
    media in the browser (ephemeral ECDH, authenticated by a 5-emoji
    ZRTP-style Short Authentication String the humans compare aloud;
    AES-256-GCM per frame), so the server only ever forwards ciphertext. An
    optional `require-e2ee` mode refuses to fall back to cleartext.
    **This implementation has not been independently audited**, and it covers
    exactly two participants — see [SECURITY.md](SECURITY.md) before relying
    on it.
  * **Login throttling & banning** — failed logins get an escalating delay
    shared across every authentication surface (WebSocket login,
    `/recordings/`, the admin API), and an address is temporarily banned
    after repeated failures; ships with a fail2ban filter/jail for
    firewall-level bans on top.
  * **Pre-join device check** — camera and microphone toggles on the login
    card with a live preview, a mic level meter and device pickers, so both
    can be tested before joining.
  * **Interface redesign** — a dark-first theme, reworked video/chat layout
    (grid/speaker view, unified people+chat panel), and Russian/English
    localisation.
  * **Android app** — a thin WebView shell ([android/](android/README.md));
    drop the built APK into the server's `data/` directory and the login card
    offers it for download at `/sozvon.apk`. It can also **install Sozvon on your
    VPS over SSH**, so a first server can be set up from the phone.
  * **Desktop app** — an Electron client ([desktop/](desktop/README.md)) with
    the same server-deployment wizard. Both clients drive
    [contrib/install.sh](contrib/install.sh) rather than reimplementing the
    install, so there is one implementation to trust.
  * **Automatic TLS & health check** — a `-letsencrypt` flag obtains
    certificates from Let's Encrypt with no extra tooling, and `/healthz` is a
    liveness endpoint for monitors and service managers.

More interface and feature work is planned. See
[FORK-CHANGES.md](FORK-CHANGES.md) for the full list of differences from
upstream Galène.

## Build

A single static Go binary, like Galène:

```sh
CGO_ENABLED=0 go build -ldflags='-s -w' -o sozvon .
```

See [galene-install.md](galene-install.md) for configuration, rooms, TLS and
TURN — Sozvon keeps the same layout (`data/`, `groups/`, `static/`).

## Installing on a server

On a fresh Debian or Ubuntu VPS, one command sets everything up — service
account, TLS certificate, firewall rules, a systemd unit and an operator
account:

```sh
curl -fsSL https://raw.githubusercontent.com/leyvanah/sozvon/main/contrib/install.sh | sudo sh
```

It prints the address to open and the generated operator password when it
finishes. Run it again later to upgrade — if the new version fails to come
up, it rolls back to the one that was working.

What it sets up is an **operator room** (see the list above): logging in at that
address gives you a dashboard, where you create a room per person you are
meeting and copy them a personal link. Nobody reaches a call without such a
link. Pass `--operator-room no` if you would rather have a single ordinary
room behind a waiting room, which anyone who knows its address may knock on.

Certificates are the one decision you may want to make yourself, with
`--tls`:

| Mode | What it does | Use it when |
|---|---|---|
| `letsencrypt-sslip` (default) | Derives a hostname from the server's IP via [sslip.io](https://sslip.io) and gets a real certificate | You have no domain and want it to just work in a browser |
| `letsencrypt-domain` | Uses a name you point at the server yourself (`--domain meet.example.com`) | You own a domain; the most self-contained option |
| `self-signed` | Generates a certificate locally, and reports its fingerprint | No DNS, or no reachable certificate authority. Browsers refuse it — only the Sozvon app can connect, by pinning that fingerprint |

`sh install.sh --help` lists the rest (mirror URL for when GitHub is
blocked, group and operator names, ports, uninstall).

The script is also meant to be driven by a program: `--detach` runs it in the
background and every stage reports progress as JSON in
`/var/lib/sozvon-install/state.json`, so a caller whose connection drops can
reconnect and read the state rather than holding the session open.

## Running as a service with automatic TLS

For a self-hosted deployment on a real domain, Sozvon can obtain and renew TLS
certificates itself — no certbot, no reverse proxy required:

```sh
./sozvon -http :443 -letsencrypt meet.example.com
```

This needs a real DNS name (not a bare IP) with ports 443 and 80 reachable
from the internet; certificates are cached under `data/acme/`. To use your own
certificate instead, omit `-letsencrypt` and place `cert.pem` and `key.pem` in
`data/`; behind a TLS-terminating reverse proxy, run with `-insecure`.

A sample systemd unit (dedicated unprivileged user, `CAP_NET_BIND_SERVICE`,
sandboxing) is in [contrib/systemd/sozvon.service](contrib/systemd/sozvon.service).
The `/healthz` endpoint returns `200 ok` while the server is running, for
uptime monitors and load-balancer health checks.

## Contributing and security

Bug reports and patches are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md),
which also explains how to tell a Sozvon bug from an upstream Galène one (that
distinction decides where a fix should go).

Security problems should be reported privately, not as a public issue:
[SECURITY.md](SECURITY.md) has the details, and is also honest about what the
end-to-end encryption does and does not promise.

## Licence

Sozvon is distributed under the MIT licence, the same terms as Galène. The
original copyright of Juliusz Chroboczek is retained in full; see
[LICENCE](LICENCE). Modifications for Sozvon are © 2026 imaprocessus, also under
the MIT licence.

## Upstream

Galène by Juliusz Chroboczek: <https://galene.org> ·
<https://github.com/jech/galene>
