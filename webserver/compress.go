package webserver

// Transparent gzip for static files.  (Sozvon)
//
// The client's first load is dominated by text: galene.js, galene.css,
// protocol.js and the FontAwesome stylesheet together are most of it, and none
// of it was compressed.  Compressing them costs a little CPU on a request that
// is already hitting the disk, and saves considerably more bytes than any
// amount of trimming the assets themselves.
//
// Correctness notes, since compressing inside a handler is easy to get subtly
// wrong:
//
//   * A compressed body is a different representation of the resource, so it
//     must not share an ETag with the identity one — a cache that saw both
//     would otherwise be free to hand a gzipped body to a client that cannot
//     decode it.  The ETag gets a suffix.
//   * Vary: Accept-Encoding for the same reason, one level up.
//   * Content-Length is computed by ServeContent for the uncompressed file and
//     is wrong the moment we compress, so it is dropped and the response is
//     chunked.
//   * Byte ranges would refer to the compressed stream, which is not what the
//     client asked for.  Rather than serve a wrong range we drop the Range
//     header, so ServeContent returns the whole file; browsers do not range
//     over stylesheets and scripts in practice.
//   * Already-compressed formats (woff2, png, mp3) gain nothing and would burn
//     CPU, so only text types are eligible.

import (
	"compress/gzip"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
)

// compressMinSize is the size below which gzip is not worth it: the gzip
// header and trailer are ~20 bytes, and a small file often grows.
const compressMinSize = 1024

// compressibleTypes are the extensions worth compressing.  Everything the web
// client serves that is not already a compressed container.
var compressibleTypes = map[string]bool{
	".css":  true,
	".html": true,
	".js":   true,
	".json": true,
	".map":  true,
	".svg":  true,
	".txt":  true,
	".xml":  true,
}

// acceptsGzip reports whether the client asked for gzip.  A qvalue of 0 is an
// explicit refusal, which is the one case where the naive substring test that
// everyone writes gets it wrong.
func acceptsGzip(r *http.Request) bool {
	for _, header := range r.Header.Values("Accept-Encoding") {
		for _, enc := range strings.Split(header, ",") {
			name, params, _ := strings.Cut(strings.TrimSpace(enc), ";")
			if !strings.EqualFold(strings.TrimSpace(name), "gzip") {
				continue
			}
			for _, param := range strings.Split(params, ";") {
				k, v, ok := strings.Cut(strings.TrimSpace(param), "=")
				if !ok || !strings.EqualFold(strings.TrimSpace(k), "q") {
					continue
				}
				q, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
				if err == nil && q == 0 {
					return false
				}
			}
			return true
		}
	}
	return false
}

// gzipWriter compresses whatever the wrapped handler writes.
type gzipWriter struct {
	http.ResponseWriter
	gz          *gzip.Writer
	wroteHeader bool
	compressing bool
}

func (gw *gzipWriter) WriteHeader(code int) {
	if gw.wroteHeader {
		return
	}
	gw.wroteHeader = true

	// Only a normal body gets compressed.  A 304 carries none, and an error
	// produced by ServeContent after we committed to gzip would otherwise be
	// announced as gzipped without being so.
	if code == http.StatusOK {
		h := gw.Header()
		h.Set("Content-Encoding", "gzip")
		// Wrong for the compressed body, and we no longer know the length.
		h.Del("Content-Length")
		// We dropped Range above, so do not claim to honour it.
		h.Del("Accept-Ranges")
		gw.compressing = true
	}
	gw.ResponseWriter.WriteHeader(code)
}

func (gw *gzipWriter) Write(b []byte) (int, error) {
	if !gw.wroteHeader {
		gw.WriteHeader(http.StatusOK)
	}
	if !gw.compressing {
		return gw.ResponseWriter.Write(b)
	}
	return gw.gz.Write(b)
}

// Close flushes the compressor.  Safe to call when nothing was compressed.
func (gw *gzipWriter) Close() error {
	if !gw.compressing {
		return nil
	}
	return gw.gz.Close()
}

// maybeCompress wraps w in a gzipping writer when the client accepts gzip and
// the file is worth compressing.  It returns the writer to serve with and a
// function that must be called before the handler returns.
//
// It must be called after the response's ETag has been set, since it amends
// it: the compressed body is a distinct representation.
func maybeCompress(w http.ResponseWriter, r *http.Request, p string, fi os.FileInfo) (http.ResponseWriter, func()) {
	// Vary regardless of what we decide for this particular request: the same
	// URL genuinely varies by Accept-Encoding, and a cache needs to know that
	// even when this response happens to be the identity one.
	w.Header().Add("Vary", "Accept-Encoding")

	if fi.Size() < compressMinSize || !compressibleTypes[strings.ToLower(path.Ext(p))] {
		return w, func() {}
	}
	if !acceptsGzip(r) {
		return w, func() {}
	}

	if etag := w.Header().Get("ETag"); etag != "" {
		// "abc" -> "abc-gzip", keeping it a valid quoted-string.
		if strings.HasSuffix(etag, "\"") {
			etag = etag[:len(etag)-1] + "-gzip\""
		}
		w.Header().Set("ETag", etag)
	}

	// A range of the compressed stream is not the range that was asked for.
	// Dropping the header makes ServeContent send the whole file.
	r.Header.Del("Range")

	gw := &gzipWriter{
		ResponseWriter: w,
		gz:             gzip.NewWriter(w),
	}
	return gw, func() { gw.Close() }
}
