# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not as a public issue.

Use GitHub's private vulnerability reporting: go to the repository's
**Security** tab → **Report a vulnerability**. This opens a private advisory
visible only to the maintainers.

Please include what you need to make the problem reproducible: the affected
version or commit, the configuration that triggers it, and the impact you
believe it has. A proof of concept helps, but a clear description is enough to
start.

Expect a first reply within a week. Sozvon is maintained by one person in their
own time, so please read that as a realistic estimate rather than a service
commitment.

## Reporting to Galène instead

Sozvon is a fork of [Galène](https://github.com/jech/galene), and the WebRTC SFU
core — media routing, codecs, RTP handling, the signalling protocol — is
largely unchanged from upstream. **If a vulnerability is in that shared core,
it affects every Galène deployment, not just Sozvon**, and should go to the
upstream maintainer as well as (or instead of) here. See the Galène
repository for how to reach them.

Roughly, the parts that are Sozvon's own — and so belong here — are:

  * the lobby / waiting room and the operator room (`group/`, `rtpconn/`,
    and the operator dashboard in `static/`)
  * end-to-end encryption (`static/e2ee*.js`)
  * login throttling and banning (`authlimit/`)
  * the Let's Encrypt integration and `/healthz` (`webserver/`)
  * the Android app (`android/`)
  * the web client's interface and localisation

When in doubt, report it here and we will forward it upstream if that is where
it belongs.

## Scope and known limitations

Some things are worth stating plainly rather than leaving to be discovered:

  * **The end-to-end encryption has not been independently audited.** It is a
    from-scratch implementation (ephemeral ECDH over the signalling channel,
    a ZRTP-style emoji Short Authentication String, AES-256-GCM per frame)
    written for this fork, and it has not been reviewed by anyone outside the
    project. It is offered as a meaningful improvement over sending cleartext
    to the server, not as a guarantee against a determined attacker. Review is
    very welcome, and findings in it are in scope.
  * **E2EE covers exactly two participants.** Calls with three or more run
    unencrypted and say so; with `require-e2ee` they are refused rather than
    downgraded. A group scheme is planned but not built.
  * **A temporary ban applies to an address, not a person.** Everyone behind
    the same NAT or proxy shares it. This is a deliberate trade-off; reports
    that it can be used to lock out a shared address are understood, and
    `contrib/fail2ban/` exists for operators who want firewall-level control.
  * **Self-hosting means you own the deployment.** TLS material, group
    configuration and TURN credentials live in `data/` and `groups/` at
    runtime and are deliberately not part of this repository. Misconfiguration
    of your own server is out of scope.

## Supported versions

Sozvon does not maintain release branches. Fixes land on `main`, and only the
latest commit there is supported. If you are running an older build, updating
is the upgrade path.
