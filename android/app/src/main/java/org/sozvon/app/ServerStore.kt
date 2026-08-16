package org.sozvon.app

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/**
 * Every server this app has been to, most recently used first.
 *
 * The app used to remember exactly one address, so opening a second server
 * cost you the first, and a server installed by the deploy wizard replaced
 * whatever was there.  The list is kept in the same SharedPreferences file as
 * the rest of the app's settings, as JSON: a handful of entries, written when
 * the user connects, read when the address screen is shown -- a database would
 * be machinery for its own sake.
 *
 * `server_url` (the single address older builds stored) is still written with
 * the most recent entry, so downgrading the app does not lose the server, and
 * an existing one is migrated into the list on first read.
 */
object ServerStore {

    private const val PREFS = "sozvon"
    private const val KEY_LIST = "servers"
    private const val KEY_URL = "server_url"
    private const val MAX = 20

    /**
     * What the deploy wizard was told last time, so that reinstalling does not
     * mean retyping it -- and, more to the point, cannot quietly reinstall a
     * server under a different certificate mode or room name than it has now,
     * just because those are the fields' defaults.
     *
     * Deploy settings only.  The SSH password and private key are credentials
     * and are never stored; the host key is (see DeployActivity).
     */
    data class Deploy(
        val sshPort: Int = 22,
        val sshUser: String = "root",
        val tls: String = "letsencrypt-sslip",
        val domain: String = "",
        val group: String = "meet",
        /** null means the installer's default, 443. */
        val httpsPort: Int? = null,
        val mirror: String = "",
    )

    /**
     * @param url  full address, as it is handed to the WebView
     * @param name what the user calls it; the host when they have not said
     * @param deploy how it was installed, when this app installed it
     */
    data class Server(
        val url: String,
        val name: String,
        val deploy: Deploy? = null,
    ) {
        /** Host and port, for a card that has no name of its own. */
        val host: String
            get() = Uri.parse(url).authority ?: url

        val label: String
            get() = if (name.isNotBlank()) name else host
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Two addresses are the same server when only a trailing slash differs. */
    private fun same(a: String, b: String) =
        a.trimEnd('/').equals(b.trimEnd('/'), ignoreCase = true)

    fun list(context: Context): List<Server> {
        val raw = prefs(context).getString(KEY_LIST, null)
        if (raw.isNullOrBlank()) {
            // Nothing stored yet: carry over the single address, if any, so an
            // upgrade does not start the user off with an empty screen.
            val old = prefs(context).getString(KEY_URL, null)
            return if (old.isNullOrBlank()) emptyList() else listOf(Server(old, ""))
        }
        return try {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { i ->
                val o = array.optJSONObject(i) ?: return@mapNotNull null
                val url = o.optString("url")
                if (url.isBlank()) null
                else Server(url, o.optString("name"), deployOf(o.optJSONObject("deploy")))
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** An entry written before deploy settings were kept has none. */
    private fun deployOf(o: JSONObject?): Deploy? {
        if (o == null) return null
        return Deploy(
            sshPort = o.optInt("sshPort", 22),
            sshUser = o.optString("sshUser", "root"),
            tls = o.optString("tls", "letsencrypt-sslip"),
            domain = o.optString("domain"),
            group = o.optString("group", "meet"),
            httpsPort = if (o.has("httpsPort")) o.optInt("httpsPort") else null,
            mirror = o.optString("mirror"),
        )
    }

    private fun save(context: Context, servers: List<Server>) {
        val array = JSONArray()
        for (s in servers.take(MAX)) {
            val o = JSONObject().put("url", s.url).put("name", s.name)
            s.deploy?.let { d ->
                o.put("deploy", JSONObject()
                    .put("sshPort", d.sshPort)
                    .put("sshUser", d.sshUser)
                    .put("tls", d.tls)
                    .put("domain", d.domain)
                    .put("group", d.group)
                    .apply { d.httpsPort?.let { put("httpsPort", it) } }
                    .put("mirror", d.mirror))
            }
            array.put(o)
        }
        val editor = prefs(context).edit().putString(KEY_LIST, array.toString())
        // Keep the old single-address key pointing at the most recent server:
        // the deep-link handler and any older build still read it.
        servers.firstOrNull()?.let { editor.putString(KEY_URL, it.url) }
        editor.apply()
    }

    /**
     * Record a visit: the server moves to the front, keeping the name it was
     * given.  Called from every path that opens one, so a server installed by
     * the deploy wizard joins the list instead of replacing it.
     *
     * @param name used only when the server is new to the list; renaming is
     *             the user's business (see [rename]).
     */
    fun remember(context: Context, url: String, name: String = "") {
        val current = list(context).toMutableList()
        val existing = current.indexOfFirst { same(it.url, url) }
        val entry = if (existing >= 0) {
            val old = current.removeAt(existing)
            // Keep how it was installed: merely visiting a server says
            // nothing about that, and losing it would leave a later reinstall
            // guessing from the fields' defaults.
            Server(url, old.name.ifBlank { name }, old.deploy)
        } else {
            Server(url, name)
        }
        current.add(0, entry)
        save(context, current)
    }

    /** As [remember], and record what the install was told. */
    fun rememberDeploy(context: Context, url: String, name: String, deploy: Deploy) {
        remember(context, url, name)
        save(context, list(context).map {
            if (same(it.url, url)) it.copy(deploy = deploy) else it
        })
    }

    fun rename(context: Context, url: String, name: String) {
        save(context, list(context).map {
            if (same(it.url, url)) it.copy(name = name.trim().take(60)) else it
        })
    }

    fun remove(context: Context, url: String) {
        val left = list(context).filterNot { same(it.url, url) }
        save(context, left)
        if (left.isEmpty()) {
            // Nothing left to point the old key at; leaving it would make the
            // app reopen a server the user has just removed.
            prefs(context).edit().remove(KEY_URL).apply()
        }
    }

    /** The server to reopen on launch, if any. */
    fun mostRecent(context: Context): Server? = list(context).firstOrNull()
}
