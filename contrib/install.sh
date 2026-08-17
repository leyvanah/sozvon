#!/bin/sh
#
# Install or upgrade Sozvon on a fresh Debian/Ubuntu server.
#
#   curl -fsSL https://raw.githubusercontent.com/leyvanah/sozvon/main/contrib/install.sh | sh
#
# or, with options:
#
#   sh install.sh --tls domain --domain meet.example.com
#
# The script is written to be driven by a program as well as by a person:
# every stage writes its progress to a JSON state file, and it can detach
# itself so a caller that loses its connection (a phone on mobile data, say)
# can reconnect and read the state instead of holding the session open.
# The Sozvon Android app drives it exactly that way over SSH.
#
# POSIX sh on purpose: a fresh VPS image is not guaranteed to have bash.

set -eu

PREFIX=/opt/sozvon
STATE_DIR=/var/lib/sozvon-install
LOG=/var/log/sozvon-install.log
REPO=leyvanah/sozvon
MIRROR=
VERSION=latest
TLS_MODE=sslip
DOMAIN=
PUBLIC_IP=
ADMIN_USER=operator
ADMIN_PASSWORD=
GROUP_NAME=meet
OPERATOR_ROOM=yes
UDP_PORT=8443
HTTPS_PORT=443
DETACH=no
UNINSTALL=no
PURGE=no
RUN_USER=sozvon

STAGE_TOTAL=9
STAGE_INDEX=0

usage() {
	cat <<EOF
Usage: $0 [option...]

  --tls MODE            letsencrypt-sslip (default), letsencrypt-domain,
                        or self-signed.  See "TLS modes" below.
  --domain NAME         DNS name, required for --tls letsencrypt-domain
  --ip ADDR             public IP, if it cannot be detected automatically
  --version VERSION     release to install (default: latest)
  --mirror URL          base URL to download from, if GitHub is unreachable
  --group NAME          name of the group to create (default: $GROUP_NAME)
  --operator-room yes|no
                        make that group an operator hub (default: yes).  The
                        operator logs in at the site root and lands on a
                        dashboard, where they create a room per client and
                        copy a personal invite link for each; a guest gets in
                        only through such a link.  With "no" the group is an
                        ordinary room behind a waiting room instead, which
                        anyone who has its address may knock on.
  --admin-user NAME     operator account (default: $ADMIN_USER)
  --admin-password PW   operator password (default: generated).  Prefer
                        --admin-password-env when other users share the
                        machine: a command line is world-readable.
  --admin-password-env  take the operator password from \$SOZVON_ADMIN_PASSWORD
  --port PORT           HTTPS port to listen on (default: $HTTPS_PORT).
                        Let's Encrypt only works on 443 -- see below.
  --udp-port PORT       UDP port for media (default: $UDP_PORT)
  --prefix DIR          install directory (default: $PREFIX)
  --detach              run in the background and print the state file path
  --uninstall           stop and remove the service, keeping data/ and groups/
  --purge               as --uninstall, and delete $PREFIX as well: rooms,
                        operator accounts, invite links, certificates and any
                        recordings.  Nothing is kept and nothing is backed up.
  -h, --help            this message

TLS modes:
  letsencrypt-sslip   Derive a hostname from the server's public IP via
                      sslip.io (1.2.3.4 -> 1-2-3-4.sslip.io) and get a real
                      certificate from Let's Encrypt.  No DNS setup, works in
                      any browser.  Depends on a third-party DNS service, and
                      the name is recorded in public certificate transparency
                      logs (the IP is public anyway).
  letsencrypt-domain  Use a name you point at this server yourself.  The most
                      self-contained option; needs an A record already set up.
  self-signed         Generate a certificate locally.  Needs no DNS and no
                      reachable certificate authority, so it works where the
                      other two cannot -- but browsers will refuse it.  Only
                      the Sozvon app can connect, by pinning the fingerprint
                      this script reports.

State and results are written to $STATE_DIR, the full log to $LOG.
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
	--tls) TLS_MODE="$2"; shift 2 ;;
	--domain) DOMAIN="$2"; shift 2 ;;
	--ip) PUBLIC_IP="$2"; shift 2 ;;
	--version) VERSION="$2"; shift 2 ;;
	--mirror) MIRROR="$2"; shift 2 ;;
	--group) GROUP_NAME="$2"; shift 2 ;;
	--operator-room) OPERATOR_ROOM="$2"; shift 2 ;;
	--admin-user) ADMIN_USER="$2"; shift 2 ;;
	--admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
	--admin-password-env) ADMIN_PASSWORD="${SOZVON_ADMIN_PASSWORD:-}"; shift ;;
	--port) HTTPS_PORT="$2"; shift 2 ;;
	--udp-port) UDP_PORT="$2"; shift 2 ;;
	--prefix) PREFIX="$2"; shift 2 ;;
	--detach) DETACH=yes; shift ;;
	--uninstall) UNINSTALL=yes; shift ;;
	--purge) UNINSTALL=yes; PURGE=yes; shift ;;
	-h|--help) usage; exit 0 ;;
	*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
	esac
done

case "$TLS_MODE" in
letsencrypt-sslip|sslip) TLS_MODE=letsencrypt-sslip ;;
letsencrypt-domain|domain) TLS_MODE=letsencrypt-domain ;;
self-signed|selfsigned) TLS_MODE=self-signed ;;
*) echo "unknown --tls mode: $TLS_MODE" >&2; exit 2 ;;
esac

case "$OPERATOR_ROOM" in
yes|true|1) OPERATOR_ROOM=yes ;;
no|false|0) OPERATOR_ROOM=no ;;
*) echo "--operator-room takes yes or no, not: $OPERATOR_ROOM" >&2; exit 2 ;;
esac

if [ "$TLS_MODE" = letsencrypt-domain ] && [ -z "$DOMAIN" ]; then
	echo "--tls letsencrypt-domain requires --domain" >&2
	exit 2
fi

# Let's Encrypt validates over the standard ports; on anything else the
# challenge cannot reach us and the certificate would never be issued.  Say so
# now rather than after a five-minute install.
case "$TLS_MODE" in
letsencrypt-*)
	if [ "$HTTPS_PORT" != 443 ]; then
		echo "--tls $TLS_MODE needs --port 443: Let's Encrypt validates on" >&2
		echo "443 (TLS-ALPN-01) or 80 (HTTP-01) and cannot reach port $HTTPS_PORT." >&2
		echo "On a host where 443 is taken, use --tls self-signed instead." >&2
		exit 2
	fi
	;;
esac

# URLs carry the port only when it is not the default, so the common case
# stays a clean https://host/.
if [ "$HTTPS_PORT" = 443 ]; then
	PORT_SUFFIX=
else
	PORT_SUFFIX=":$HTTPS_PORT"
fi

# ---------------------------------------------------------------- state ----
#
# The state file is the contract with any program driving this script.  It is
# written atomically (write to a temporary file, then rename) so a reader can
# never observe a half-written file, however often it polls.

json_escape() {
	# escape backslashes, double quotes and control characters
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
	    -e 's/	/\\t/g' | tr -d '\r\n'
}

write_state() {
	_status="$1"
	_message="$2"
	_error="${3:-}"
	mkdir -p "$STATE_DIR"
	cat > "$STATE_DIR/state.json.tmp" <<EOF
{
  "schema": 1,
  "status": "$(json_escape "$_status")",
  "stage": "$(json_escape "$STAGE_NAME")",
  "stage_index": $STAGE_INDEX,
  "stage_total": $STAGE_TOTAL,
  "message": "$(json_escape "$_message")",
  "error": "$(json_escape "$_error")",
  "version": "$(json_escape "$VERSION")",
  "updated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
	mv "$STATE_DIR/state.json.tmp" "$STATE_DIR/state.json"
}

STAGE_NAME=starting

stage() {
	STAGE_INDEX=$((STAGE_INDEX + 1))
	STAGE_NAME="$1"
	echo "==> [$STAGE_INDEX/$STAGE_TOTAL] $2"
	write_state running "$2"
}

fail() {
	echo "ERROR: $1" >&2
	write_state failed "failed during $STAGE_NAME" "$1"
	# The state file now holds the real reason.  Mark it final so the EXIT
	# trap below does not overwrite it with a bare exit status -- that
	# message is all a program driving this script would have to show.
	FINISHED=yes
	exit 1
}

# Report any unexpected early exit, so a driver never sees the state file
# stuck at "running" with no explanation.  Only fires when nothing has
# already written a final state.
trap 'rc=$?; [ $rc -ne 0 ] && [ "${FINISHED:-no}" = no ] && \
    write_state failed "aborted during $STAGE_NAME" "exit status $rc"' EXIT

# --------------------------------------------------------------- detach ----

if [ "$DETACH" = yes ]; then
	# Re-run ourselves fully detached: a new session, no controlling
	# terminal, output to the log.  The caller can drop the connection
	# immediately and poll $STATE_DIR/state.json afterwards.
	mkdir -p "$STATE_DIR"
	STAGE_NAME=starting
	write_state running "starting in the background"
	_self=$(mktemp /tmp/sozvon-install.XXXXXX.sh)
	cat "$0" > "$_self" 2>/dev/null || fail "cannot copy the installer"
	chmod +x "$_self"
	# The password goes through the environment, never the command line:
	# /proc/<pid>/cmdline is world-readable, so an --admin-password
	# argument would be visible to every user on the machine for as long
	# as the install runs.  /proc/<pid>/environ is readable only by the
	# owner.
	SOZVON_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
	setsid sh "$_self" \
	    --tls "$TLS_MODE" \
	    ${DOMAIN:+--domain "$DOMAIN"} \
	    ${PUBLIC_IP:+--ip "$PUBLIC_IP"} \
	    --version "$VERSION" \
	    ${MIRROR:+--mirror "$MIRROR"} \
	    --group "$GROUP_NAME" \
	    --operator-room "$OPERATOR_ROOM" \
	    --admin-user "$ADMIN_USER" \
	    --admin-password-env \
	    --port "$HTTPS_PORT" \
	    --udp-port "$UDP_PORT" \
	    --prefix "$PREFIX" \
	    >> "$LOG" 2>&1 < /dev/null &
	echo "$STATE_DIR/state.json"
	FINISHED=yes
	exit 0
fi

# Output goes wherever the caller sent it: to the terminal when run by hand,
# and to $LOG when run with --detach (the re-exec below redirects it there).
# No tee, no process substitution -- this is POSIX sh, and >(...) is a
# bashism dash would reject.  It also keeps a single EXIT trap, which is all
# POSIX gives us, free for the failure reporting above.
mkdir -p "$(dirname "$LOG")"

# ------------------------------------------------------------ uninstall ----

if [ "$UNINSTALL" = yes ]; then
	STAGE_TOTAL=1
	stage uninstall "removing the service"
	systemctl stop sozvon 2>/dev/null || true
	systemctl disable sozvon 2>/dev/null || true
	rm -f /etc/systemd/system/sozvon.service
	# A server installed before the rename runs under the old unit, and
	# removing only the new one would leave it running and holding the
	# ports while the client reports the server as removed.
	if [ -e /etc/systemd/system/oryn.service ]; then
		systemctl stop oryn 2>/dev/null || true
		systemctl disable oryn 2>/dev/null || true
		rm -f /etc/systemd/system/oryn.service
		echo "also removed the pre-rename oryn.service"
	fi
	systemctl daemon-reload 2>/dev/null || true
	if [ "$PURGE" = yes ]; then
		# --prefix takes anything; deleting the wrong tree recursively as
		# root is not a mistake that can be walked back.
		case "$PREFIX" in
		""|/|/bin|/boot|/etc|/home|/lib|/opt|/root|/srv|/usr|/var)
			fail "refusing to purge $PREFIX" ;;
		esac
		rm -rf "$PREFIX"
		# The pre-rename tree, if this machine still has one: a purge that
		# left it behind would keep the rooms and the operator's password
		# on a machine whose owner asked for everything to be gone.
		if [ "$PREFIX" != /opt/oryn ] && [ -d /opt/oryn ]; then
			rm -rf /opt/oryn
			echo "also removed the pre-rename /opt/oryn"
		fi
		# The service account exists only to run this; leaving it behind
		# would make a later install think the machine is half set up.
		userdel "$RUN_USER" 2>/dev/null || true
		[ "$RUN_USER" != oryn ] && userdel oryn 2>/dev/null || true
		echo "Removed $PREFIX: rooms, operator accounts, invite links,"
		echo "certificates and any recordings are gone."
		write_state done "purged"
	else
		echo "Service removed.  $PREFIX/data and $PREFIX/groups were kept;"
		echo "delete $PREFIX yourself if you want them gone."
		write_state done "uninstalled"
	fi
	FINISHED=yes
	exit 0
fi

# ------------------------------------------------------------ preflight ----

stage preflight "checking the system"

[ "$(id -u)" = 0 ] || fail "this script must run as root"

command -v systemctl >/dev/null 2>&1 || fail "systemd is required"

case "$(uname -s)" in
Linux) ;;
*) fail "only Linux is supported (found $(uname -s))" ;;
esac

case "$(uname -m)" in
x86_64|amd64) ARCH=amd64 ;;
aarch64|arm64) ARCH=arm64 ;;
*) fail "unsupported architecture $(uname -m); build from source instead" ;;
esac

if command -v apt-get >/dev/null 2>&1; then
	PKG=apt
elif command -v dnf >/dev/null 2>&1; then
	PKG=dnf
else
	PKG=none
	echo "note: no apt or dnf found; assuming curl, tar and openssl are present"
fi

install_pkg() {
	case "$PKG" in
	apt) DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
	dnf) dnf install -y -q "$@" ;;
	*) return 1 ;;
	esac
}

need=
for tool in curl tar openssl; do
	command -v "$tool" >/dev/null 2>&1 || need="$need $tool"
done
if [ -n "$need" ]; then
	echo "installing:$need"
	[ "$PKG" = apt ] && apt-get update -qq
	# shellcheck disable=SC2086
	install_pkg $need || fail "could not install:$need"
fi

# The project was called Oryn before it was called Sozvon, and the rename
# moved the service, the install prefix and the service account.  A server
# installed under the old name would otherwise be invisible here: the new
# service would be installed alongside the old one, the old unit would keep
# the ports, and the rooms and the operator password -- which live in
# groups/ -- would be left behind in a directory nothing reads any more.
# Adopt such an installation instead.
LEGACY_PREFIX=/opt/oryn
LEGACY_UNIT=/etc/systemd/system/oryn.service
if [ -e "$LEGACY_UNIT" ] || [ -d "$LEGACY_PREFIX" ]; then
	if [ "$PREFIX" = /opt/sozvon ] && [ -d "$LEGACY_PREFIX" ] &&
	   [ ! -d "$PREFIX" ]; then
		echo "found an Oryn installation: migrating to $PREFIX"
		# A move, not a copy: certificates, rooms and recordings can be
		# large, and two copies of the group files would be two answers
		# to "what is the operator's password".
		mv "$LEGACY_PREFIX" "$PREFIX" ||
		    fail "could not move $LEGACY_PREFIX to $PREFIX"
	elif [ -d "$LEGACY_PREFIX" ]; then
		echo "note: $LEGACY_PREFIX left in place; this install uses $PREFIX"
	fi
	if [ -e "$LEGACY_UNIT" ]; then
		systemctl stop oryn 2>/dev/null || true
		systemctl disable oryn 2>/dev/null || true
		rm -f "$LEGACY_UNIT"
		systemctl daemon-reload 2>/dev/null || true
		echo "removed the old oryn.service"
	fi
	# The old service account is dropped further down, once the files it
	# used to own have been chowned to the new one -- not here, or a failure
	# in between would leave the tree owned by a uid with no user.
fi

# Is this a fresh install or an upgrade?  It decides whether a busy port is a
# problem or simply us, already running.
UPGRADE=no
if [ -e /etc/systemd/system/sozvon.service ] || [ -L "$PREFIX/current" ]; then
	UPGRADE=yes
fi

# A port already in use is the most common reason a fresh install appears to
# work and then silently does not, so say so now rather than at the verify
# stage.  On an upgrade the listener on 443 is our own service, so the check
# would refuse every upgrade -- skip it and let the verify stage judge, since
# it restarts the service and then actually asks it for /healthz.
if [ "$UPGRADE" = no ]; then
	# 80 matters only for the Let's Encrypt HTTP-01 challenge and the
	# http->https redirect; a self-signed install never touches it.
	ports="$HTTPS_PORT"
	case "$TLS_MODE" in letsencrypt-*) ports="80 $HTTPS_PORT" ;; esac
	for port in $ports; do
		if command -v ss >/dev/null 2>&1 &&
		   ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN; then
			fail "port $port is already in use; stop whatever is listening (a web server?) and re-run"
		fi
	done
else
	echo "existing installation found: upgrading"
fi

MEM_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_KB" -gt 0 ] && [ "$MEM_KB" -lt 400000 ]; then
	echo "warning: only $((MEM_KB / 1024)) MB of RAM; Sozvon will run but a busy call may not"
fi

# --------------------------------------------------------------- user ------

stage user "creating the service account and directories"

if ! id "$RUN_USER" >/dev/null 2>&1; then
	useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin \
	    "$RUN_USER" 2>/dev/null ||
	useradd --system --home-dir "$PREFIX" --shell /sbin/nologin \
	    "$RUN_USER" ||
	fail "could not create the $RUN_USER user"
fi

mkdir -p "$PREFIX/versions" "$PREFIX/data" "$PREFIX/groups" \
         "$PREFIX/recordings" "$STATE_DIR"

# ---------------------------------------------------------------- fetch ----

stage fetch "downloading Sozvon"

BASE=${MIRROR:-https://github.com/$REPO/releases}
if [ "$VERSION" = latest ]; then
	# Resolve "latest" to a concrete version so the state file, the install
	# directory and any later upgrade all name the same thing.
	if [ -n "$MIRROR" ]; then
		# A mirror exists precisely because GitHub is not reachable, so
		# asking GitHub what "latest" means would defeat it.  The mirror
		# says so itself, in a one-line file next to the archives.
		VERSION=$(curl -fsSL "$MIRROR/latest" 2>/dev/null | tr -d ' \t\r\n')
		[ -n "$VERSION" ] || fail "the mirror has no 'latest' file; pass --version explicitly"
	else
		VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
		    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1) ||
		    fail "could not reach GitHub to resolve the latest version; pass --version, or --mirror"
		[ -n "$VERSION" ] || fail "could not determine the latest version; pass --version explicitly"
	fi
fi

ARCHIVE="sozvon_${VERSION}_linux_${ARCH}.tar.gz"
if [ -n "$MIRROR" ]; then
	URL="$MIRROR/$ARCHIVE"
	SUMS_URL="$MIRROR/SHA256SUMS"
else
	URL="$BASE/download/$VERSION/$ARCHIVE"
	SUMS_URL="$BASE/download/$VERSION/SHA256SUMS"
fi

TMP=$(mktemp -d /tmp/sozvon-install.XXXXXX)
cleanup_tmp() { rm -rf "$TMP"; }

curl -fsSL -o "$TMP/$ARCHIVE" "$URL" || {
	cleanup_tmp
	fail "download failed: $URL"
}
curl -fsSL -o "$TMP/SHA256SUMS" "$SUMS_URL" || {
	cleanup_tmp
	fail "could not download SHA256SUMS from $SUMS_URL"
}

# Refuse to install something whose checksum we cannot confirm: this archive
# is about to be run as a service on someone's server.
( cd "$TMP" && grep " [ *]\{0,1\}$ARCHIVE\$" SHA256SUMS > expected.txt &&
  sha256sum -c expected.txt >/dev/null 2>&1 ) || {
	cleanup_tmp
	fail "checksum mismatch for $ARCHIVE -- refusing to install"
}

DEST="$PREFIX/versions/$VERSION"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$TMP/$ARCHIVE" -C "$TMP" || { cleanup_tmp; fail "could not unpack $ARCHIVE"; }
mv "$TMP/sozvon_${VERSION}_linux_${ARCH}"/* "$DEST/" ||
	{ cleanup_tmp; fail "unexpected archive layout"; }
cleanup_tmp

[ -x "$DEST/sozvon" ] || chmod +x "$DEST/sozvon" "$DEST/galenectl" 2>/dev/null || true

# Remember what was running, so a failed verify can go back to it.
PREVIOUS=
if [ -L "$PREFIX/current" ]; then
	PREVIOUS=$(readlink "$PREFIX/current" || true)
fi

# ------------------------------------------------------------------ tls ----

stage tls "working out the certificate"

detect_ip() {
	# An address supplied by the caller always wins.  A client that reached
	# this server to run the installer knows an address that demonstrably
	# works; guessing is only for when nobody told us.
	if [ -n "$PUBLIC_IP" ]; then
		printf '%s' "$PUBLIC_IP"
		return 0
	fi
	# Prefer the address the kernel would use to reach the internet: on a
	# normal VPS that is the public one, and it asks nobody.
	_ip=$(ip route get 1.1.1.1 2>/dev/null |
	    sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)
	case "$_ip" in
	""|10.*|127.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*)
		# Behind NAT (or unknown): fall back to asking an outside
		# service what it sees.
		_ip=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)
		;;
	esac
	printf '%s' "$_ip"
}

CERT_FINGERPRINT=
case "$TLS_MODE" in
letsencrypt-sslip)
	IP=$(detect_ip)
	[ -n "$IP" ] || fail "could not determine this server's public IP; pass --ip"
	case "$IP" in
	*[!0-9.]*|"") fail "detected an implausible public IP: '$IP'; pass --ip" ;;
	esac
	HOSTNAME=$(echo "$IP" | tr '.' '-').sslip.io
	SOZVON_ARGS="-http :$HTTPS_PORT -letsencrypt $HOSTNAME"
	echo "using $HOSTNAME (from $IP)"
	;;
letsencrypt-domain)
	HOSTNAME="$DOMAIN"
	# Checking the A record now turns a confusing certificate failure two
	# stages later into a clear message here.
	resolved=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
	myip=$(detect_ip)
	if [ -n "$resolved" ] && [ -n "$myip" ] && [ "$resolved" != "$myip" ]; then
		echo "warning: $DOMAIN resolves to $resolved but this server looks like $myip."
		echo "         Let's Encrypt will fail unless the DNS record points here."
	elif [ -z "$resolved" ]; then
		echo "warning: $DOMAIN does not resolve yet; Let's Encrypt will fail until it does."
	fi
	SOZVON_ARGS="-http :$HTTPS_PORT -letsencrypt $HOSTNAME"
	;;
self-signed)
	IP=$(detect_ip)
	HOSTNAME=${DOMAIN:-$IP}
	[ -n "$HOSTNAME" ] || fail "could not determine a name or IP for the certificate; pass --ip or --domain"
	if [ ! -f "$PREFIX/data/cert.pem" ]; then
		# The SAN has to match however the client will address this
		# server.  With no IP detected, "IP:" alone is a syntax error
		# openssl rejects, so build the list from what we actually have.
		SAN=
		[ -n "$DOMAIN" ] && SAN="DNS:$DOMAIN"
		if [ -n "$IP" ]; then
			[ -n "$SAN" ] && SAN="$SAN,"
			# --ip may carry a name rather than an address (a caller
			# passing "the address you reach this server at" cannot
			# always tell).  "IP:some.host" is a syntax error openssl
			# rejects outright, so label it by what it looks like.
			case "$IP" in
			*[!0-9.]*) SAN="${SAN}DNS:$IP" ;;
			*) SAN="${SAN}IP:$IP" ;;
			esac
		fi
		[ -n "$SAN" ] || fail "no name or IP for the certificate; pass --ip or --domain"
		openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
		    -subj "/CN=$HOSTNAME" \
		    -addext "subjectAltName=$SAN" \
		    -keyout "$PREFIX/data/key.pem" \
		    -out "$PREFIX/data/cert.pem" >/dev/null 2>&1 ||
		    fail "could not generate a self-signed certificate"
		chmod 600 "$PREFIX/data/key.pem"
	fi
	CERT_FINGERPRINT=$(openssl x509 -in "$PREFIX/data/cert.pem" \
	    -noout -fingerprint -sha256 2>/dev/null |
	    sed 's/.*=//' | tr -d ':' | tr 'A-Z' 'a-z')
	SOZVON_ARGS="-http :$HTTPS_PORT"
	;;
esac

# --------------------------------------------------------------- config ----

stage config "writing the configuration"

if [ -z "$ADMIN_PASSWORD" ]; then
	# 18 bytes of base64 from the kernel CSPRNG, minus characters that are
	# awkward to read aloud or paste.
	ADMIN_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '=+/' | cut -c1-20)
fi

GROUP_FILE="$PREFIX/groups/$GROUP_NAME.json"
if [ -f "$GROUP_FILE" ]; then
	echo "$GROUP_FILE already exists, keeping it"
	ADMIN_PASSWORD=
	# What we report at the end depends on the shape of the group, so read
	# it back rather than assuming the mode asked for on the command line:
	# an upgrade must not tell the operator to open a hub that is not there.
	if grep -q '"operator-room"[[:space:]]*:[[:space:]]*true' "$GROUP_FILE"; then
		OPERATOR_ROOM=yes
	else
		OPERATOR_ROOM=no
	fi
else
	# Hash the password rather than storing it in the clear: the group file
	# stays readable to anyone who gets the file, and this way that is not
	# enough to log in.
	HASHED=$("$DEST/galenectl" hash-password -password "$ADMIN_PASSWORD" 2>/dev/null) ||
	    fail "could not hash the operator password"

	if [ "$OPERATOR_ROOM" = yes ]; then
		# An operator hub: the operator logs in at the site root and
		# lands on a dashboard, where they create a room per client and
		# hand out a personal link to each.  No wildcard-user and no
		# public listing on purpose -- nobody reaches a call without a
		# link the operator made.
		cat > "$GROUP_FILE" <<EOF
{
    "displayName": "$GROUP_NAME",
    "operator-room": true,
    "users": {
        "$ADMIN_USER": {
            "password": $HASHED,
            "permissions": "op"
        }
    }
}
EOF
	else
		cat > "$GROUP_FILE" <<EOF
{
    "displayName": "$GROUP_NAME",
    "lobby": true,
    "users": {
        "$ADMIN_USER": {
            "password": $HASHED,
            "permissions": "op"
        }
    },
    "wildcard-user": {
        "password": {"type": "wildcard"},
        "permissions": "present"
    }
}
EOF
	fi
	chmod 600 "$GROUP_FILE"
fi

ln -sfn "$DEST" "$PREFIX/current"
chown -R "$RUN_USER:$RUN_USER" "$PREFIX"

# Everything the pre-rename service account owned now belongs to the new one,
# so the old login has nothing left to hold and can go.  Only when its own
# directory is gone: if it is still there, something was not migrated, and an
# orphaned uid on those files would be worse than an unused account.
if [ "$RUN_USER" != oryn ] && ! [ -d /opt/oryn ] && id oryn >/dev/null 2>&1; then
	userdel oryn 2>/dev/null && echo "removed the old oryn service account"
fi

# ------------------------------------------------------------- firewall ----

stage firewall "opening the ports"

# 443 web + TLS-ALPN, 80 for the HTTP-01 challenge and the redirect,
# $UDP_PORT for media (a single multiplexed port, so this stays simple),
# 1194 for the built-in TURN relay.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
	ufw allow 80/tcp   >/dev/null 2>&1 || true
	ufw allow "$HTTPS_PORT/tcp" >/dev/null 2>&1 || true
	ufw allow 1194/tcp >/dev/null 2>&1 || true
	ufw allow 1194/udp >/dev/null 2>&1 || true
	ufw allow "$UDP_PORT/udp" >/dev/null 2>&1 || true
	echo "ufw rules added"
else
	echo "no active ufw; make sure 80/tcp, $HTTPS_PORT/tcp, 1194/tcp+udp and"
	echo "$UDP_PORT/udp are reachable if your provider filters ports"
fi

# -------------------------------------------------------------- service ----

stage service "installing the systemd service"

cat > /etc/systemd/system/sozvon.service <<EOF
[Unit]
Description=Sozvon video conferencing server
Documentation=https://github.com/$REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$PREFIX
ExecStart=$PREFIX/current/sozvon $SOZVON_ARGS -static $PREFIX/current/static/ \\
    -data $PREFIX/data/ -groups $PREFIX/groups/ \\
    -recordings $PREFIX/recordings/ -udp-range $UDP_PORT

Restart=on-failure
RestartSec=5

AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
RestrictNamespaces=true
ReadWritePaths=$PREFIX/data $PREFIX/groups $PREFIX/recordings

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sozvon >/dev/null 2>&1 || fail "could not enable the service"
systemctl restart sozvon || fail "could not start the service"

# --------------------------------------------------------------- verify ----

stage verify "waiting for the server to answer"

ok=no
i=0
# Ask for the server's real name, but pin that name to the loopback.
#
# Probing https://127.0.0.1 directly does not work in the Let's Encrypt
# modes, and fails in a way that looks like the server is dead: the
# certificate is issued for $HOSTNAME, the handshake for any other name is
# refused before a certificate is offered, and the connection dies with an
# internal-error alert.  -k does not help -- the refusal is the server's, not
# curl's.  Resolving the real name to 127.0.0.1 keeps the check local, and
# needs no working DNS or return path through the provider's network, while
# still presenting the name the certificate is for.
PROBE_URL="https://$HOSTNAME:$HTTPS_PORT/healthz"
# Let's Encrypt issuance can take a little while on first start.
while [ $i -lt 60 ]; do
	# shellcheck disable=SC2086
	if curl -fsk --max-time 5 \
	    --resolve "$HOSTNAME:$HTTPS_PORT:127.0.0.1" \
	    "$PROBE_URL" 2>/dev/null | grep -q ok; then
		ok=yes
		break
	fi
	if ! systemctl is-active --quiet sozvon; then
		break
	fi
	i=$((i + 1))
	sleep 2
done

if [ "$ok" != yes ]; then
	echo "--- last 40 lines of the service log ---" >&2
	journalctl -u sozvon -n 40 --no-pager 2>/dev/null >&2 || true
	# An upgrade that does not come up goes back to what was working.
	if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ] && [ "$PREVIOUS" != "$DEST" ]; then
		echo "rolling back to $PREVIOUS" >&2
		ln -sfn "$PREVIOUS" "$PREFIX/current"
		systemctl restart sozvon || true
		fail "the new version did not come up; rolled back to $(basename "$PREVIOUS")"
	fi
	fail "the server did not answer on $PROBE_URL"
fi

if [ "$TLS_MODE" != self-signed ]; then
	# The local check above accepts any certificate (-k).  Confirm the real
	# one was issued, so we do not report success on a name that browsers
	# will reject.
	if ! curl -fsS --max-time 20 "https://$HOSTNAME$PORT_SUFFIX/healthz" >/dev/null 2>&1; then
		echo "warning: https://$HOSTNAME$PORT_SUFFIX/healthz is not answering with a valid"
		echo "         certificate yet.  Let's Encrypt may still be issuing it;"
		echo "         check 'journalctl -u sozvon' in a minute."
	fi
fi

# ----------------------------------------------------------------- done ----

stage done "finishing up"

ORIGIN="https://$HOSTNAME$PORT_SUFFIX"
if [ "$OPERATOR_ROOM" = yes ]; then
	# The hub is served at the site root, and that is where its operator
	# should go: the address to open is the origin itself.
	URL="$ORIGIN/"
	HUB_JSON=true
else
	URL="$ORIGIN/group/$GROUP_NAME/"
	HUB_JSON=false
fi

cat > "$STATE_DIR/result.json" <<EOF
{
  "schema": 1,
  "url": "$(json_escape "$URL")",
  "origin": "$(json_escape "$ORIGIN")",
  "hostname": "$(json_escape "$HOSTNAME")",
  "group": "$(json_escape "$GROUP_NAME")",
  "hub": $HUB_JSON,
  "admin_user": "$(json_escape "$ADMIN_USER")",
  "admin_password": "$(json_escape "$ADMIN_PASSWORD")",
  "tls_mode": "$(json_escape "$TLS_MODE")",
  "cert_sha256": "$(json_escape "$CERT_FINGERPRINT")",
  "version": "$(json_escape "$VERSION")",
  "prefix": "$(json_escape "$PREFIX")"
}
EOF
chmod 600 "$STATE_DIR/result.json"

write_state done "installed $VERSION"
FINISHED=yes

cat <<EOF

Sozvon $VERSION is running.

  Address:   $URL
  Operator:  $ADMIN_USER
EOF

if [ -n "$ADMIN_PASSWORD" ]; then
	cat <<EOF
  Password:  $ADMIN_PASSWORD

Write the password down now: it is stored only as a hash, and this is the
only time it is shown.  It is also in $STATE_DIR/result.json (root only) --
delete that file once you have it.
EOF
else
	echo "  Password:  unchanged (the group file already existed)"
fi

if [ "$OPERATOR_ROOM" = yes ]; then
	cat <<EOF

Log in at that address as the operator and you land on a dashboard, not in a
call.  Create a room there for each person you are meeting and send them the
link it gives you: that link is the only way in, so there is no address for
anyone else to guess.
EOF
fi

if [ "$TLS_MODE" = self-signed ]; then
	cat <<EOF

This server uses a self-signed certificate, so a normal browser will refuse
it.  Connect with the Sozvon app and pin this fingerprint:

  SHA-256: $CERT_FINGERPRINT
EOF
fi

echo
echo "Logs: journalctl -u sozvon -f"
