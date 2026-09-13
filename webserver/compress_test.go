package webserver

// Tests for the transparent gzip layer.  (Sozvon)
//
// Compressing inside a handler is easy to get subtly wrong in ways no browser
// complains about until a cache is involved -- a shared ETag between the
// compressed and identity representations, a stale Content-Length, a range
// served against the compressed stream.  The comments at the top of
// compress.go list those hazards; this file pins them down.

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAcceptsGzip(t *testing.T) {
	tests := []struct {
		header []string
		want   bool
	}{
		{nil, false},
		{[]string{""}, false},
		{[]string{"gzip"}, true},
		{[]string{"GZIP"}, true},
		{[]string{" gzip "}, true},
		{[]string{"gzip, deflate, br"}, true},
		{[]string{"deflate, br, gzip"}, true},
		{[]string{"deflate"}, false},
		{[]string{"br"}, false},
		{[]string{"gzip;q=1.0"}, true},
		{[]string{"gzip;q=0.5"}, true},
		{[]string{"gzip; q=0.001"}, true},
		// A qvalue of zero is an explicit refusal, and is the case a
		// substring test gets wrong.
		{[]string{"gzip;q=0"}, false},
		{[]string{"gzip;q=0.0"}, false},
		{[]string{"gzip; q=0"}, false},
		{[]string{"deflate, gzip;q=0"}, false},
		{[]string{"GZIP;Q=0"}, false},
		// Two header lines rather than one comma-separated list.
		{[]string{"deflate", "gzip"}, true},
		// A different encoding whose name merely contains "gzip".
		{[]string{"x-gzip"}, false},
	}
	for _, test := range tests {
		r := httptest.NewRequest("GET", "/galene.js", nil)
		for _, h := range test.header {
			r.Header.Add("Accept-Encoding", h)
		}
		got := acceptsGzip(r)
		if got != test.want {
			t.Errorf("acceptsGzip(%q) = %v, want %v",
				test.header, got, test.want)
		}
	}
}

// writeTemp creates a file of n bytes of compressible content with the given
// extension, and returns its path and FileInfo.
func writeTemp(t *testing.T, ext string, n int) (string, os.FileInfo) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "asset"+ext)
	body := bytes.Repeat([]byte("compress me please. "), n/20+1)[:n]
	err := os.WriteFile(path, body, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return path, fi
}

// maybeCompress decides; these check the decision and the headers it leaves
// behind, which is what a cache downstream will act on.
func TestMaybeCompressDecision(t *testing.T) {
	tests := []struct {
		name     string
		ext      string
		size     int
		encoding string
		want     bool
	}{
		{"a large script is compressed", ".js", 4096, "gzip", true},
		{"so is a stylesheet", ".css", 4096, "gzip", true},
		{"and markup", ".html", 4096, "gzip", true},
		{"a small file is not worth it", ".js", 100, "gzip", false},
		{"an already-compressed font is skipped",
			".woff2", 4096, "gzip", false},
		{"so is an image", ".png", 4096, "gzip", false},
		{"and audio", ".mp3", 4096, "gzip", false},
		{"a client that did not ask gets identity",
			".js", 4096, "deflate", false},
		{"nor does one that refused gzip",
			".js", 4096, "gzip;q=0", false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path, fi := writeTemp(t, test.ext, test.size)
			r := httptest.NewRequest("GET", "/"+filepath.Base(path), nil)
			r.Header.Set("Accept-Encoding", test.encoding)
			rec := httptest.NewRecorder()
			rec.Header().Set("ETag", `"deadbeef"`)

			w, done := maybeCompress(rec, r, path, fi)
			_, err := w.Write([]byte("hello"))
			if err != nil {
				t.Fatal(err)
			}
			done()

			compressed := rec.Header().Get("Content-Encoding") == "gzip"
			if compressed != test.want {
				t.Errorf("Content-Encoding %q, want gzip=%v",
					rec.Header().Get("Content-Encoding"),
					test.want)
			}

			// A compressed body is a different representation, so it
			// must not share the identity ETag.
			etag := rec.Header().Get("ETag")
			if test.want && etag != `"deadbeef-gzip"` {
				t.Errorf("compressed ETag %q, want a suffix", etag)
			}
			if !test.want && etag != `"deadbeef"` {
				t.Errorf("identity ETag %q, want it untouched", etag)
			}

			// The URL varies by Accept-Encoding whichever way this
			// particular request went, and a cache must be told.
			if rec.Header().Get("Vary") != "Accept-Encoding" {
				t.Errorf("Vary %q", rec.Header().Get("Vary"))
			}
		})
	}
}

// A range would refer to the compressed stream, which is not what was asked
// for, so the header is dropped and the whole file served instead.
func TestMaybeCompressDropsRange(t *testing.T) {
	path, fi := writeTemp(t, ".js", 4096)
	r := httptest.NewRequest("GET", "/"+filepath.Base(path), nil)
	r.Header.Set("Accept-Encoding", "gzip")
	r.Header.Set("Range", "bytes=0-99")

	_, done := maybeCompress(httptest.NewRecorder(), r, path, fi)
	done()

	if r.Header.Get("Range") != "" {
		t.Errorf("Range survived as %q", r.Header.Get("Range"))
	}
}

// A 304 carries no body, so it must not be announced as gzipped.
func TestMaybeCompressLeavesNotModifiedAlone(t *testing.T) {
	path, fi := writeTemp(t, ".js", 4096)
	r := httptest.NewRequest("GET", "/"+filepath.Base(path), nil)
	r.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()

	w, done := maybeCompress(rec, r, path, fi)
	w.WriteHeader(http.StatusNotModified)
	done()

	if rec.Header().Get("Content-Encoding") != "" {
		t.Errorf("304 announced Content-Encoding %q",
			rec.Header().Get("Content-Encoding"))
	}
}

// End to end through the running server: the bytes a browser receives must
// decompress to the file on disk, and the identity request must still work.
func TestServeCompressedAsset(t *testing.T) {
	setup()

	// The server opened its static root at startup, so the file has to go
	// where that root points rather than into a fresh temp directory.
	body := []byte(strings.Repeat("// sozvon compressible payload\n", 200))
	name := "sozvon-compress-test.js"
	path := filepath.Join(StaticRoot, name)
	err := os.WriteFile(path, body, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(path) })

	get := func(encoding string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(
			"GET", "http://localhost:1234/"+name, nil,
		)
		if err != nil {
			t.Fatal(err)
		}
		// Set explicitly: net/http adds gzip on its own and then
		// decompresses transparently, which would hide the headers.
		req.Header.Set("Accept-Encoding", encoding)
		resp, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	resp := get("gzip")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %v", resp.Status)
	}
	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding %q",
			resp.Header.Get("Content-Encoding"))
	}
	if resp.Header.Get("Vary") != "Accept-Encoding" {
		t.Errorf("Vary %q", resp.Header.Get("Vary"))
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	// The length ServeContent computed describes the file on disk and is
	// wrong the moment the body is compressed.  net/http may put an
	// accurate one back for a body small enough to buffer, which is fine --
	// what must never happen is announcing the uncompressed size.
	if cl := resp.ContentLength; cl >= 0 && cl != int64(len(raw)) {
		t.Errorf("Content-Length %v, body is %v bytes (file is %v)",
			cl, len(raw), len(body))
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("body is not gzip: %v", err)
	}
	got, err := io.ReadAll(gz)
	if err != nil {
		t.Fatalf("reading the compressed body: %v", err)
	}
	if len(raw) >= len(body) {
		t.Errorf("compressed to %v bytes from %v: no saving",
			len(raw), len(body))
	}
	if !bytes.Equal(got, body) {
		t.Errorf("decompressed %v bytes, want %v", len(got), len(body))
	}
	gzipETag := resp.Header.Get("ETag")

	plain := get("identity")
	defer plain.Body.Close()
	if plain.Header.Get("Content-Encoding") != "" {
		t.Errorf("identity request got Content-Encoding %q",
			plain.Header.Get("Content-Encoding"))
	}
	got, err = io.ReadAll(plain.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("identity body differs from the file")
	}
	if plainETag := plain.Header.Get("ETag"); plainETag == gzipETag &&
		gzipETag != "" {
		t.Errorf("both representations share the ETag %q", gzipETag)
	}
}
