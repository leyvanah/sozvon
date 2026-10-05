#!/usr/bin/env bash
# Start a packaged Sozvon build in smoke-test mode and wait for its verdict.
#
#   desktop/scripts/smoke.sh <command to start the app> [args...]
#
# The release workflow runs this on every platform it builds for, against the
# installed or unpacked app rather than the sources: what is being checked is
# the package -- that it contains what it needs, that its icons load, that its
# sandbox starts -- and none of that is visible before packaging.
#
# The app reports through stdout (see smokeTest() in src/main.js):
# SOZVON_SMOKE_OK once its window and the page below the bar have loaded and
# its tray icon is not empty, SOZVON_SMOKE_FAIL otherwise.  Anything else --
# no line at all, a crash, a quiet exit -- is a failure too: a check that can
# pass without the app saying so would pass on an app that never started.
#
# SMOKE_SHOT=<file.png> takes a screenshot of the whole screen once the app has
# passed, for a person to look at; a failed screenshot is reported, not fatal.

set -u

if [ "$#" -eq 0 ]; then
	echo "usage: $0 <command> [args...]" >&2
	exit 2
fi

log=$(mktemp)
# Seconds the app stays up after passing, long enough for the screenshot.
SOZVON_SMOKE_TEST=15 "$@" >"$log" 2>&1 &
pid=$!

screenshot() {
	case "$(uname -s)" in
	Darwin) screencapture -x "$1" ;;
	Linux) import -window root "$1" ;;
	MINGW*|MSYS*|CYGWIN*)
		powershell -NoProfile -Command "
			Add-Type -AssemblyName System.Windows.Forms, System.Drawing
			\$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
			\$bmp = New-Object System.Drawing.Bitmap \$b.Width, \$b.Height
			[System.Drawing.Graphics]::FromImage(\$bmp).CopyFromScreen(\$b.Location, [System.Drawing.Point]::Empty, \$b.Size)
			\$bmp.Save('$1')" ;;
	*) return 1 ;;
	esac
}

for _ in $(seq 1 120); do
	if grep -q '^SOZVON_SMOKE_OK' "$log"; then
		grep '^SOZVON_SMOKE_OK' "$log"
		if [ -n "${SMOKE_SHOT:-}" ]; then
			sleep 3   # let the first frame settle
			screenshot "$SMOKE_SHOT" || echo "screenshot failed (not fatal)" >&2
		fi
		wait "$pid"
		rc=$?
		if [ "$rc" -ne 0 ]; then
			cat "$log"
			echo "smoke: the app passed, then exited with $rc" >&2
			exit 1
		fi
		exit 0
	fi
	if grep -q '^SOZVON_SMOKE_FAIL' "$log" || ! kill -0 "$pid" 2>/dev/null; then
		cat "$log"
		echo "smoke: failed -- see the app's output above" >&2
		exit 1
	fi
	sleep 1
done

cat "$log"
kill "$pid" 2>/dev/null
echo "smoke: no verdict from the app in 120 s" >&2
exit 1
