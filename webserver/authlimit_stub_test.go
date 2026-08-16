package webserver

import (
	"github.com/leyvanah/sozvon/authlimit"
)

func init() {
	// Every test request comes from the same loopback address, so the
	// escalating authentication-failure delay would slow the suite to
	// a crawl and the ban would break the upstream bad-auth tests.
	// The package has its own unit tests.
	authlimit.SetDisabled(true)
}
