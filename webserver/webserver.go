package webserver

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"

	"github.com/jech/cert"
	"github.com/leyvanah/sozvon/authlimit"
	"github.com/leyvanah/sozvon/diskwriter"
	"github.com/leyvanah/sozvon/group"
	"github.com/leyvanah/sozvon/rtpconn"
)

var server *http.Server

// challengeServer, when Let's Encrypt is enabled, is the plain-HTTP server
// on :80 that answers ACME HTTP-01 challenges and redirects everything else
// to HTTPS.  nil otherwise.
var challengeServer *http.Server

var StaticRoot string
var staticRoot *os.Root

var Insecure bool

// LetsEncrypt, when non-empty, is a comma-separated list of hostnames for
// which TLS certificates are obtained automatically from Let's Encrypt.
// Mutually exclusive with Insecure.
var LetsEncrypt string

// Dev, when set, disables HTTP caching of static assets: they are served
// with "no-cache" (still revalidated via ETag) so edits to the web client
// show up on a normal reload.  Off in production.
var Dev bool

func Serve(address string, dataDir string) error {
	var err error
	staticRoot, err = os.OpenRoot(StaticRoot)
	if err != nil {
		return err
	}
	// Sozvon: the root is wrapped so an operator-room hub can be served at
	// "/" (see rootHandler); plain static files still win over it.
	fh := &fileHandler{staticRoot}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		rootHandler(w, r, fh)
	})
	http.HandleFunc("/group/", groupHandler)
	http.HandleFunc("/recordings",
		func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r,
				"/recordings/", http.StatusPermanentRedirect)
		})
	http.HandleFunc("/recordings/", recordingsHandler)
	http.HandleFunc("/ws", wsHandler)
	http.HandleFunc("/public-groups.json", publicHandler)
	http.HandleFunc("/galene-api/", apiHandler)
	http.HandleFunc("/healthz", healthzHandler)
	apk := filepath.Join(dataDir, "sozvon.apk")
	http.HandleFunc("/sozvon.apk",
		func(w http.ResponseWriter, r *http.Request) {
			serveAPK(w, r, apk)
		})

	s := &http.Server{
		Addr:              address,
		ReadHeaderTimeout: 60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if LetsEncrypt != "" {
		if Insecure {
			return errors.New(
				"-letsencrypt and -insecure are mutually exclusive")
		}
		hosts := splitHosts(LetsEncrypt)
		if len(hosts) == 0 {
			return errors.New("-letsencrypt: no hostnames given")
		}
		m := &autocert.Manager{
			Cache:      autocert.DirCache(filepath.Join(dataDir, "acme")),
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(hosts...),
		}
		s.TLSConfig = &tls.Config{
			MinVersion:     tls.VersionTLS12,
			GetCertificate: m.GetCertificate,
			// TLS-ALPN-01 is answered on this same 443 listener, so no extra
			// port is strictly required; the :80 server below adds HTTP-01
			// and an http->https redirect when it can bind the port.
			NextProtos: []string{"h2", "http/1.1", acme.ALPNProto},
		}
		if _, port, err := net.SplitHostPort(address); err == nil &&
			port != "443" {
			log.Printf("Note: -letsencrypt usually needs -http :443 so the "+
				"ACME TLS-ALPN-01 challenge is reachable (got port %v)",
				port)
		}
		challengeServer = &http.Server{
			Addr:              ":80",
			Handler:           m.HTTPHandler(nil),
			ReadHeaderTimeout: 60 * time.Second,
			IdleTimeout:       120 * time.Second,
		}
		go func() {
			err := challengeServer.ListenAndServe()
			if err != nil && err != http.ErrServerClosed {
				// Not fatal: TLS-ALPN-01 on :443 can still obtain certs.
				// Usually this is a privilege error binding :80 without
				// CAP_NET_BIND_SERVICE, or another process already on :80.
				log.Printf("Let's Encrypt HTTP-01 listener (:80): %v", err)
			}
		}()
	} else if !Insecure {
		certificate := cert.New(
			filepath.Join(dataDir, "cert.pem"),
			filepath.Join(dataDir, "key.pem"),
		)
		s.TLSConfig = &tls.Config{
			MinVersion: tls.VersionTLS12,
			GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
				return certificate.Get()
			},
		}
	}
	s.RegisterOnShutdown(func() {
		group.Shutdown("server is shutting down")
	})

	server = s

	proto := "tcp"
	if strings.HasPrefix(address, "/") {
		proto = "unix"
	}

	listener, err := net.Listen(proto, address)
	if err != nil {
		return err
	}
	go func() {
		defer listener.Close()
		if !Insecure {
			err = s.ServeTLS(listener, "", "")
		} else {
			err = s.Serve(listener)
		}
	}()
	return nil
}

func cspHeader(w http.ResponseWriter, connect string) {
	c := "connect-src ws: wss: 'self'; "
	if connect != "" {
		c = "connect-src " + connect + " ws: wss: 'self'; "
	}
	w.Header().Add("Content-Security-Policy",
		c+"img-src 'self'; media-src blob: 'self'; script-src 'unsafe-eval' 'self'; style-src 'self'; default-src 'self'")

	// Make browser stop sending referrer information
	w.Header().Add("Referrer-Policy", "no-referrer")

	// Require correct MIME type to load CSS and JS
	w.Header().Add("X-Content-Type-Options", "nosniff")
}

// serveAPK serves the Android app package if the deployment provides one
// (sozvon.apk in the data directory).  The login page probes this endpoint
// with a HEAD request and only shows its download button when it responds.
func serveAPK(w http.ResponseWriter, r *http.Request, p string) {
	fi, err := os.Stat(p)
	if err != nil || fi.IsDir() {
		notFound(w)
		return
	}
	w.Header().Set("Content-Type",
		"application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition",
		"attachment; filename=\"sozvon.apk\"")
	http.ServeFile(w, r, p)
}

// healthzHandler is a liveness probe: it answers 200 as long as the HTTP
// server is up, with no dependency on any subsystem (depending on one would
// make this a readiness check instead).  It is meant for load balancers,
// uptime monitors and systemd/container health checks, so it is
// unauthenticated and never cached.
func healthzHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, "GET, HEAD")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		fmt.Fprintln(w, "ok")
	}
}

func notFound(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)

	f, err := staticRoot.Open("404.html")
	if err != nil {
		fmt.Fprintln(w, "<p>Not found</p>")
		return
	}
	defer f.Close()

	io.Copy(w, f)
}

func internalError(w http.ResponseWriter, format string, args ...any) {
	log.Printf(format, args...)
	http.Error(w, "Internal server error", http.StatusInternalServerError)
}

var ErrIsDirectory = errors.New("is a directory")

func httpError(w http.ResponseWriter, err error) {
	if errors.Is(err, os.ErrNotExist) {
		notFound(w)
		return
	}
	if errors.Is(err, group.ErrUnknownPermission) {
		http.Error(w, "unknown permission", http.StatusBadRequest)
		return
	}
	var autherr *group.NotAuthorisedError
	if errors.As(err, &autherr) {
		log.Printf("HTTP server error: %v", err)
		http.Error(w, "not authorised", http.StatusUnauthorized)
		return
	}
	var mberr *http.MaxBytesError
	if errors.As(err, &mberr) {
		http.Error(w, "Request body too large",
			http.StatusRequestEntityTooLarge)
		return
	}
	internalError(w, "HTTP server error: %v", err)
}

func methodNotAllowed(w http.ResponseWriter, methods string) {
	w.Header().Set("Allow", "OPTIONS, "+methods)
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}

const (
	normalCacheControl       = "max-age=1800"
	veryCachableCacheControl = "max-age=86400"
)

func redirect(w http.ResponseWriter, r *http.Request) bool {
	conf, err := group.GetConfiguration()
	if err != nil || conf.CanonicalHost == "" {
		return false
	}

	if strings.EqualFold(r.Host, conf.CanonicalHost) {
		return false
	}

	u := url.URL{
		Scheme: "https",
		Host:   conf.CanonicalHost,
		Path:   r.URL.Path,
	}
	http.Redirect(w, r, u.String(), http.StatusMovedPermanently)
	return true
}

func makeCachable(w http.ResponseWriter, p string, fi os.FileInfo, cachable bool) {
	etag := fmt.Sprintf("\"%v-%v\"", fi.Size(), fi.ModTime().UnixNano())
	w.Header().Set("ETag", etag)
	if !cachable || Dev {
		w.Header().Set("cache-control", "no-cache")
		return
	}

	cc := normalCacheControl
	if strings.HasPrefix(p, "/third-party/") {
		cc = veryCachableCacheControl
	} else {
		// Web-client source (HTML/JS/CSS) has no content hash in its filename,
		// so a long max-age would pin a stale galene.js/galene.css in the
		// browser for up to 30 minutes after a deploy — exactly the "my fix
		// isn't showing up" trap.  Serve these revalidate-only: "no-cache"
		// still returns 304 (via the ETag above) when nothing changed, but a
		// new deploy is picked up on the very next reload.  Other assets
		// (images, audio, fonts) keep the longer max-age. (Sozvon)
		switch strings.ToLower(path.Ext(p)) {
		case ".html", ".js", ".css":
			cc = "no-cache"
		}
	}

	w.Header().Set("Cache-Control", cc)
}

// fileHandler is our custom reimplementation of http.FileServer
type fileHandler struct {
	root *os.Root
}

func (fh *fileHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if redirect(w, r) {
		return
	}

	cspHeader(w, "")
	if !strings.HasPrefix(r.URL.Path, "/") {
		http.Error(w,
			"internal server error", http.StatusInternalServerError)
		return
	}
	var p string
	if r.URL.Path == "/" {
		p = "."
	} else {
		p = r.URL.Path[1:]
	}

	f, err := fh.root.Open(p)
	if err != nil {
		httpError(w, err)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		httpError(w, err)
		return
	}

	if fi.IsDir() {
		u := r.URL.Path
		if u[len(u)-1] != '/' {
			http.Redirect(w, r, u+"/", http.StatusPermanentRedirect)
			return
		}

		index := path.Join(p, "index.html")
		ff, err := fh.root.Open(index)
		if err != nil {
			// return 403 if index.html doesn't exist
			if errors.Is(err, os.ErrNotExist) {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			httpError(w, err)
			return
		}
		defer ff.Close()
		dd, err := ff.Stat()
		if err != nil {
			httpError(w, err)
			return
		}
		if dd.IsDir() {
			httpError(w, ErrIsDirectory)
			return
		}
		f, fi = ff, dd
		p = index
	}

	makeCachable(w, p, fi, true)
	cw, done := maybeCompress(w, r, p, fi)
	defer done()
	http.ServeContent(cw, r, fi.Name(), fi.ModTime(), f)
}

// serveFile is similar to http.ServeFile, except that it doesn't check
// for .. and adds cachability headers.
func serveFile(w http.ResponseWriter, r *http.Request, root *os.Root, p string) {
	f, err := root.Open(p)
	if err != nil {
		httpError(w, err)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		httpError(w, err)
		return
	}

	if fi.IsDir() {
		httpError(w, ErrIsDirectory)
		return
	}

	makeCachable(w, p, fi, true)
	cw, done := maybeCompress(w, r, p, fi)
	defer done()
	http.ServeContent(cw, r, fi.Name(), fi.ModTime(), f)
}

func parseGroupName(prefix string, p string) string {
	if !strings.HasPrefix(p, prefix) {
		return ""
	}

	name := p[len(prefix):]
	if name == "" {
		return ""
	}

	if name[0] == '.' {
		return ""
	}

	if filepath.Separator != '/' &&
		strings.ContainsRune(name, filepath.Separator) {
		return ""
	}

	name = path.Clean("/" + name)
	return name[1:]
}

func splitPath(pth string) (string, string, string) {
	index := strings.Index(pth, "/.")
	if index < 0 {
		return pth, "", ""
	}

	index2 := strings.Index(pth[index+1:], "/")
	if index2 < 0 {
		return pth[:index], pth[index+1:], ""
	}
	return pth[:index], pth[index+1 : index+1+index2], pth[index+1+index2:]
}

// rootHandler serves the operator hub's app at the site root when an
// operator-room hub exists, so an operator logs in at "/" and lands on the
// dashboard.  A guest has no hub credentials and so cannot get in there; guests
// use their per-client token links instead.  When no hub exists the root falls
// back to the ordinary static handler (the landing page).
func rootHandler(w http.ResponseWriter, r *http.Request, fh *fileHandler) {
	if r.URL.Path == "/.status" {
		rootStatusHandler(w, r)
		return
	}
	if hub := group.OperatorHubName(); hub != "" {
		// Short client links: /<slug>/ and /<slug>/.status map to the hub's
		// child room hub/<slug>, so a guest link needs no /group/<hub>/
		// prefix.  A real static file/dir of the same name still wins.
		if slug, ok := shortRoomSlug(r.URL.Path); ok && !staticExists(slug) {
			r.URL.Path = "/group/" + hub + "/" + slug +
				r.URL.Path[1+len(slug):]
			groupHandler(w, r)
			return
		}
		if r.URL.Path == "/" {
			if redirect(w, r) {
				return
			}
			g, err := group.Add(hub, nil)
			if err != nil {
				httpError(w, err)
				return
			}
			status := g.Status(false, nil)
			cspHeader(w, status.AuthServer)
			serveFile(w, r, staticRoot, "galene.html")
			return
		}
	}
	fh.ServeHTTP(w, r)
}

// shortRoomSlug matches a short client-link path (/<slug>/ or /<slug>/.status)
// and returns the slug -- a single URL-safe segment, the shape of an
// operator-room child room.
func shortRoomSlug(pth string) (string, bool) {
	if len(pth) < 2 || pth[0] != '/' {
		return "", false
	}
	i := strings.IndexByte(pth[1:], '/')
	if i < 0 {
		return "", false // no trailing slash: not a room link
	}
	slug := pth[1 : 1+i]
	switch pth[1+i:] {
	case "/", "/.status":
	default:
		return "", false
	}
	if slug == "" || slug[0] == '-' {
		return "", false
	}
	for _, c := range slug {
		if !((c >= 'a' && c <= 'z') ||
			(c >= '0' && c <= '9') || c == '-') {
			return "", false
		}
	}
	return slug, true
}

// staticExists reports whether static/<name> exists, so short room routing
// never shadows a real static file or directory (e.g. /third-party/).
func staticExists(name string) bool {
	_, err := os.Stat(filepath.Join(StaticRoot, name))
	return err == nil
}

// rootStatusHandler answers /.status with the operator hub's status, so the web
// client served at "/" learns which group it is (mirrors groupStatusHandler).
func rootStatusHandler(w http.ResponseWriter, r *http.Request) {
	hub := group.OperatorHubName()
	if hub == "" {
		notFound(w)
		return
	}
	g, err := group.Add(hub, nil)
	if err != nil {
		httpError(w, err)
		return
	}
	base, err := baseURL(r)
	if err != nil {
		internalError(w, "Parse ProxyURL: %v", err)
		return
	}
	d := g.Status(false, base)
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-cache")

	if r.Method == "HEAD" {
		return
	}

	json.NewEncoder(w).Encode(d)
}

func groupHandler(w http.ResponseWriter, r *http.Request) {
	if redirect(w, r) {
		return
	}

	dir, kind, rest := splitPath(r.URL.Path)
	if kind == ".status" && rest == "" {
		groupStatusHandler(w, r)
		return
	} else if kind == ".status.json" && rest == "" {
		http.Redirect(w, r, dir+"/"+".status",
			http.StatusPermanentRedirect)
		return
	} else if kind == ".whip" {
		if rest == "" {
			whipEndpointHandler(w, r)
		} else {
			whipResourceHandler(w, r)
		}
		return
	} else if kind != "" {
		notFound(w)
		return
	}

	name := parseGroupName("/group/", r.URL.Path)
	if name == "" {
		notFound(w)
		return
	}

	g, err := group.Add(name, nil)
	if err != nil {
		httpError(w, err)
		return
	}

	if r.URL.Path != "/group/"+name+"/" {
		http.Redirect(w, r, "/group/"+name+"/",
			http.StatusPermanentRedirect)
		return
	}

	if redirect := g.Description().Redirect; redirect != "" {
		http.Redirect(w, r, redirect, http.StatusPermanentRedirect)
		return
	}

	status := g.Status(false, nil)
	cspHeader(w, status.AuthServer)
	serveFile(w, r, staticRoot, "galene.html")
}

func baseURL(r *http.Request) (*url.URL, error) {
	conf, err := group.GetConfiguration()
	if err != nil {
		return nil, err
	}
	var pu *url.URL
	if conf.ProxyURL != "" {
		pu, err = url.Parse(conf.ProxyURL)
		if err != nil {
			return nil, err
		}
	}
	scheme := "https"
	if r.TLS == nil {
		scheme = "http"
	}
	host := r.Host
	path := ""
	if pu != nil {
		if pu.Scheme != "" {
			scheme = pu.Scheme
		}
		if pu.Host != "" {
			host = pu.Host
		}
		path = pu.Path
	}
	base := url.URL{
		Scheme: scheme,
		Host:   host,
		Path:   path,
	}
	return &base, nil
}

func groupStatusHandler(w http.ResponseWriter, r *http.Request) {
	pth, kind, rest := splitPath(r.URL.Path)
	if kind != ".status" || rest != "" {
		internalError(w, "groupStatusHandler: this shouldn't happen")
		return
	}
	name := parseGroupName("/group/", pth)
	if name == "" {
		notFound(w)
		return
	}

	g, err := group.Add(name, nil)
	if err != nil {
		httpError(w, err)
		return
	}

	base, err := baseURL(r)
	if err != nil {
		internalError(w, "Parse ProxyURL: %v", err)
		return
	}
	d := g.Status(false, base)
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-cache")

	if r.Method == "HEAD" {
		return
	}

	e := json.NewEncoder(w)
	e.Encode(d)
}

func publicHandler(w http.ResponseWriter, r *http.Request) {
	base, err := baseURL(r)
	if err != nil {
		log.Printf("couldn't determine group base: %v", err)
		httpError(w, err)
		return
	}
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-cache")

	if r.Method == "HEAD" {
		return
	}

	g := group.GetPublic(base)
	e := json.NewEncoder(w)
	e.Encode(g)
}

// globalAdminMatch checks whether the given credentials match with an
// administrator entry in the global configuration file.
func globalAdminMatch(username, password string) (bool, error) {
	conf, err := group.GetConfiguration()
	if err != nil {
		return false, err
	}

	u, found := conf.Users[username]
	if found {
		ok, err := u.Password.Match(password)
		if err != nil {
			return false, err
		}
		if !ok {
			return false, nil
		}
		perms := u.Permissions.Permissions(nil)
		for _, p := range perms {
			if p == "admin" {
				return true, nil
			}
		}
		return false, nil
	}

	return false, nil
}

func failAuthentication(w http.ResponseWriter, realm string) {
	w.Header().Set("www-authenticate",
		fmt.Sprintf("basic realm=\"%v\"", realm))
	http.Error(w, "Haha!", http.StatusUnauthorized)
}

// tooManyLogins rejects a request from an address temporarily banned
// after too many failed logins, without prompting for credentials (Sozvon).
func tooManyLogins(w http.ResponseWriter, left time.Duration) {
	w.Header().Set("retry-after",
		fmt.Sprintf("%d", int(left/time.Second)+1))
	http.Error(w, "too many failed logins, try again later",
		http.StatusTooManyRequests)
}

// CheckOrigin adds the CORS header to the reply.
// It obeys the AllowOrigin or AllowAdminOrigin field of the global
// configuration, depending on the value of admin.
// It returns true if the header was added, false otherwise.
func CheckOrigin(w http.ResponseWriter, r *http.Request, admin bool) bool {
	if w != nil {
		w.Header().Add("Vary", "Origin")
	}

	origins := r.Header["Origin"]
	if len(origins) == 0 {
		return true
	}
	origin := origins[0]

	ok := false
	o, err := url.Parse(origin)
	if err == nil && strings.EqualFold(o.Host, r.Host) {
		ok = true
	} else {
		conf, err := group.GetConfiguration()
		if err != nil {
			return false
		}

		allow := conf.AllowOrigin
		if admin {
			allow = conf.AllowAdminOrigin
		}
		for _, a := range allow {
			if strings.EqualFold(origin, a) {
				ok = true
				break
			}
		}
	}

	if !ok {
		return false
	}

	if w != nil {
		w.Header().Add("Access-Control-Allow-Origin", origin)
	}
	return true
}

var wsUpgrader = websocket.Upgrader{
	HandshakeTimeout: 30 * time.Second,
	CheckOrigin: func(r *http.Request) bool {
		return CheckOrigin(nil, r, false)
	},
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Websocket upgrade: %v", err)
		return
	}

	var addr net.Addr
	tcpaddr, err := net.ResolveTCPAddr("tcp", r.RemoteAddr)
	if err != nil {
		log.Printf("ResolveTCPAddr: %v", err)
	} else {
		addr = tcpaddr
	}

	go func() {
		err := rtpconn.StartClient(conn, addr)
		if err != nil {
			log.Printf("client: %v", err)
		}
	}()
}

func recordingsHandler(w http.ResponseWriter, r *http.Request) {
	if redirect(w, r) {
		return
	}

	if len(r.URL.Path) < 12 || r.URL.Path[:12] != "/recordings/" {
		internalError(w, "reconrdingsHandler: this shouldn't happen")
		return
	}

	p := r.URL.Path[12:]
	if p == "" {
		http.Error(w, "Bad group name", http.StatusBadRequest)
		return
	}

	if filepath.Separator != '/' &&
		strings.ContainsRune(p, filepath.Separator) {
		http.Error(w, "Bad character in filename",
			http.StatusBadRequest)
		return
	}

	root, err := os.OpenRoot(diskwriter.Directory)
	if err != nil {
		httpError(w, err)
		return
	}
	defer root.Close()

	f, err := root.Open(p)
	if err != nil {
		httpError(w, err)
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		httpError(w, err)
		return
	}

	var group, filename string
	if fi.IsDir() {
		for len(p) > 0 && p[len(p)-1] == '/' {
			p = p[:len(p)-1]
		}
		group = parseGroupName("", p)
		if group == "" {
			http.Error(w, "Bad group name", http.StatusBadRequest)
			return
		}
	} else {
		group, filename = path.Split(p)
		group = parseGroupName("", group)
		if group == "" {
			http.Error(w, "Bad group name", http.StatusBadRequest)
			return
		}
	}

	u := "/recordings/" + group + "/" + filename
	if r.URL.Path != u {
		http.Redirect(w, r, u, http.StatusPermanentRedirect)
		return
	}

	if banned, left := authlimit.Banned(authlimit.HostKey(r.RemoteAddr)); banned {
		tooManyLogins(w, left)
		return
	}

	ok := checkRecordPermission(w, r, group)
	if !ok {
		failAuthentication(w, "recordings/"+group)
		return
	}

	if filename == "" {
		if r.Method == "POST" {
			handleGroupAction(w, r, group)
		} else {
			serveGroupRecordings(w, r, f, group)
		}
		return
	}

	// Ensure the file is uncachable if it's still recording
	cachable := time.Since(fi.ModTime()) > time.Minute
	makeCachable(w, path.Join("/recordings/", p), fi, cachable)
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

func handleGroupAction(w http.ResponseWriter, r *http.Request, group string) {
	if r.Method != "POST" {
		methodNotAllowed(w, "POST")
		return
	}

	err := r.ParseForm()
	if err != nil {
		http.Error(w, "Couldn't parse request", http.StatusBadRequest)
		return
	}

	q := r.Form.Get("q")

	switch q {
	case "delete":
		filename := r.Form.Get("filename")
		if group == "" || filename == "" {
			http.Error(w, "No filename provided",
				http.StatusBadRequest)
			return
		}
		if strings.ContainsRune(filename, '/') ||
			strings.ContainsRune(filename, filepath.Separator) {
			http.Error(w, "Bad character in filename",
				http.StatusBadRequest)
			return
		}
		root, err := os.OpenRoot(diskwriter.Directory)
		if err != nil {
			httpError(w, err)
			return
		}
		defer root.Close()

		err = root.Remove(
			filepath.Join(group, path.Clean("/"+filename)),
		)
		if err != nil {
			httpError(w, err)
			return
		}
		http.Redirect(w, r, "/recordings/"+group+"/",
			http.StatusSeeOther)
		return
	default:
		http.Error(w, "Unknown query", http.StatusBadRequest)
	}
}

func checkRecordPermission(w http.ResponseWriter, r *http.Request, groupname string) bool {
	user, pass, ok := r.BasicAuth()
	if !ok {
		return false
	}

	desc, err := group.GetDescription(groupname)
	if err != nil {
		return false
	}

	_, p, err := desc.GetPermission(
		groupname,
		group.ClientCredentials{
			Username: &user,
			Password: pass,
		},
	)
	record := false
	if err == nil {
		for _, v := range p {
			if v == "record" {
				record = true
				break
			}
		}
	}
	if err != nil || !record {
		var autherr *group.NotAuthorisedError
		if errors.As(err, &autherr) {
			// escalating delay slows password guessing (Sozvon)
			authlimit.Failure(authlimit.HostKey(r.RemoteAddr),
				"recordings")
		}
		return false
	}

	authlimit.Reset(authlimit.HostKey(r.RemoteAddr))
	return true
}

func serveGroupRecordings(w http.ResponseWriter, r *http.Request, f *os.File, group string) {
	if r.Method != "HEAD" && r.Method != "GET" {
		methodNotAllowed(w, "HEAD,GET")
		return
	}
	// read early, so we return permission errors to HEAD
	fis, err := f.Readdir(-1)
	if err != nil {
		httpError(w, err)
		return
	}

	sort.Slice(fis, func(i, j int) bool {
		return fis[i].Name() < fis[j].Name()
	})

	w.Header().Set("content-type", "text/html; charset=utf-8")
	w.Header().Set("cache-control", "no-cache")

	if r.Method == "HEAD" {
		return
	}

	fmt.Fprintf(w, "<!DOCTYPE html>\n<html><head>\n")
	fmt.Fprintf(w, "<title>Recordings for group %v</title>\n", group)
	fmt.Fprintf(w, "<link rel=\"stylesheet\" type=\"text/css\" href=\"/common.css\"/>")
	fmt.Fprintf(w, "</head><body>\n")

	fmt.Fprintf(w, "<table>\n")
	for _, fi := range fis {
		if fi.IsDir() {
			continue
		}
		fmt.Fprintf(w, "<tr><td><a href=\"./%v\">%v</a></td><td>%d</td>",
			html.EscapeString(fi.Name()),
			html.EscapeString(fi.Name()),
			fi.Size(),
		)
		fmt.Fprintf(w,
			"<td><form action=\"/recordings/%v/\" method=\"post\">"+
				"<input type=\"hidden\" name=\"filename\" value=\"%v\">"+
				"<button type=\"submit\" name=\"q\" value=\"delete\">Delete</button>"+
				"</form></td></tr>\n",
			url.PathEscape(group), html.EscapeString(fi.Name()))
	}
	fmt.Fprintf(w, "</table>\n")
	fmt.Fprintf(w, "</body></html>\n")
}

// splitHosts splits a comma-separated list of hostnames, trimming spaces and
// dropping empty entries.
func splitHosts(s string) []string {
	var hosts []string
	for _, h := range strings.Split(s, ",") {
		h = strings.TrimSpace(h)
		if h != "" {
			hosts = append(hosts, h)
		}
	}
	return hosts
}

func Shutdown() {
	if challengeServer != nil {
		challengeServer.Close()
		challengeServer = nil
	}
	if server == nil {
		log.Printf("Shutting down nonexistent server")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	server.Shutdown(ctx)
	server = nil
}
