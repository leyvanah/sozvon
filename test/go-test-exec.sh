#!/bin/sh
#
# Run a Go test binary from a fixed path, for `go test -exec` on Windows:
#
#   go test -exec "sh $PWD/test/go-test-exec.sh" ./...
#
# Windows Firewall asks about every new program that listens on the network,
# and remembers the answer by the program's path.  `go test` runs each
# package's tests from a fresh temporary directory, so the tests that open
# sockets -- group (the UDP mux, on every interface but loopback), ice,
# turnserver -- asked again on every run: 163 times by 2026-11-11, each
# leaving two rules behind.  Copied to one path per package, each is asked
# about once.
#
# Elsewhere the binary runs where Go put it.  When the copy cannot be made --
# another run of the same package has it open -- it does too, and the firewall
# asks as it used to.

bin=$1
shift
case "$(uname -s)" in
MINGW*|MSYS*|CYGWIN*) ;;
*) exec "$bin" "$@" ;;
esac

dir=${SOZVON_TEST_BIN_DIR:-$HOME/.cache/sozvon-test}
name=${bin##*[\\/]}
if mkdir -p "$dir" && cp -f "$bin" "$dir/$name" 2>/dev/null; then
	exec "$dir/$name" "$@"
fi
exec "$bin" "$@"
