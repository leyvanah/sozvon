#!/bin/sh
#
# Run the browser suite against a server built from this tree.
#
#   test/browser/run.sh [playwright args...]
#
# Builds the server, starts it on a port of its own with the rooms in
# ./groups and a throwaway data directory, runs Playwright, stops the server.
# The same script runs in CI and on a laptop, so the two cannot drift apart.
#
# A run that executed nothing is a failure, not a pass: Playwright exits 0
# when every test was skipped, and a green suite that tested nothing is how
# this project has been fooled before.  With SOZVON_FAIL_ON_SKIP=1 (as in CI)
# any skipped test fails the run as well; without it, skips are listed with
# their reasons, never folded into "passed".

set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
port=${SOZVON_TEST_PORT:-18443}
work=$(mktemp -d "${TMPDIR:-/tmp}/sozvon-browser.XXXXXX")
bin="$work/sozvon"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) bin="$bin.exe" ;; esac

srv=
stop() {
	if [ -n "$srv" ]; then
		kill "$srv" 2>/dev/null || taskkill //PID "$srv" //F >/dev/null 2>&1 || true
		wait "$srv" 2>/dev/null || true
	fi
	rm -rf "$work"
}
trap stop EXIT
trap 'exit 130' INT TERM

echo "browser tests: building the server" >&2
( cd "$root" && CGO_ENABLED=0 go build -o "$bin" . )

mkdir -p "$work/data" "$work/recordings"
"$bin" -insecure -dev -http "localhost:$port" \
    -static "$root/static/" -groups "$here/groups/" \
    -data "$work/data/" -recordings "$work/recordings/" \
    >"$work/server.log" 2>&1 &
srv=$!

i=0
until curl -fs -m 1 "http://localhost:$port/healthz" >/dev/null 2>&1; do
	i=$((i + 1))
	if [ $i -ge 30 ] || ! kill -0 "$srv" 2>/dev/null; then
		echo "browser tests: the server never came up" >&2
		sed 's/^/    /' "$work/server.log" >&2
		exit 1
	fi
	sleep 1
done

results="$here/test-results/results.json"
mkdir -p "$here/test-results"
rm -f "$results"
rc=0
( cd "$here" && SOZVON_URL="http://localhost:$port" \
    PLAYWRIGHT_JSON_OUTPUT_NAME="$results" \
    npx playwright test --reporter=list,json "$@" ) || rc=$?

if [ ! -s "$results" ]; then
	echo "browser tests: no results file -- Playwright did not run" >&2
	exit 1
fi

# Count what actually ran.  Reasons for skips come from test.skip(cond, why).
node - "$results" <<'EOF' || rc=1
const r = require(process.argv[2]);
const s = r.stats;
const ran = s.expected + s.unexpected + s.flaky;
console.error(`browser tests: ${ran} ran (${s.expected} passed, ` +
    `${s.unexpected} failed, ${s.flaky} flaky), ${s.skipped} skipped`);
const walk = (suite, out) => {
    for (const sp of suite.specs || [])
        for (const t of sp.tests)
            if (t.status === 'skipped') {
                const why = (t.annotations || [])
                    .filter(a => a.type === 'skip').map(a => a.description)
                    .filter(Boolean).join('; ');
                out.push(`${sp.file}: ${sp.title}${why ? ' -- ' + why : ''}`);
            }
    for (const c of suite.suites || []) walk(c, out);
    return out;
};
const skipped = [];
for (const su of r.suites) walk(su, skipped);
for (const l of skipped) console.error(`    SKIPPED ${l}`);
if (ran === 0) {
    console.error('browser tests: nothing ran -- refusing to call that a pass');
    process.exit(1);
}
if (skipped.length && process.env.SOZVON_FAIL_ON_SKIP) {
    console.error('browser tests: skips are failures here (SOZVON_FAIL_ON_SKIP)');
    process.exit(1);
}
EOF

exit $rc
