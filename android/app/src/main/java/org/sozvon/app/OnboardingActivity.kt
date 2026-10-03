package org.sozvon.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import org.json.JSONObject
import org.sozvon.app.deploy.CertPins
import java.net.URL
import java.security.KeyStore
import java.security.cert.X509Certificate
import java.util.Locale
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * The first-run onboarding: the shared screens in onboarding/ at the root of
 * the repository, copied into the assets at build time (see the
 * syncOnboarding task) and shown here in a WebView.  The desktop app shows
 * the very same files.
 *
 * The page asks for what it cannot do itself through one object,
 * window.SozvonOnboarding: call(id, method, json), answered later with
 * SozvonHost._resolve(id, json).  See onboarding/host.js for the other side
 * and onboarding/README.md for the list of methods.
 *
 * How it ends, as the result MainActivity receives:
 *  - RESULT_OK with [EXTRA_OPEN_URL]: open that address (the onboarding is
 *    done);
 *  - [RESULT_SKIPPED]: show the server list (done as well);
 *  - RESULT_CANCELED: Back on the first screen -- leave the app, and greet
 *    the person again next time, since they never got anywhere.
 */
class OnboardingActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_OPEN_URL = "org.sozvon.app.ONBOARDING_OPEN_URL"
        const val RESULT_SKIPPED = RESULT_FIRST_USER

        private const val PREFS = "sozvon"
        private const val KEY_DONE = "onboarding_done"

        fun isDone(context: Context) =
            context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_DONE, false)

        fun markDone(context: Context) {
            context.getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putBoolean(KEY_DONE, true).apply()
        }

        /**
         * Whether to greet this person at all: never connected anywhere, and
         * not arriving with somewhere to go already.  An existing user
         * upgrading the app has saved servers and so never sees it.
         */
        fun shouldShow(context: Context) =
            !isDone(context) && ServerStore.list(context).isEmpty()

        private const val PAGE = "file:///android_asset/onboarding/index.html"
    }

    private lateinit var webView: WebView
    private val main = Handler(Looper.getMainLooper())

    /** The request waiting for the permission dialog, and for the wizard. */
    private var mediaRequestId = -1
    private var deployRequestId = -1

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        val id = mediaRequestId
        mediaRequestId = -1
        if (id >= 0) reply(id, JSONObject()
            .put("camera", has(Manifest.permission.CAMERA))
            .put("mic", has(Manifest.permission.RECORD_AUDIO)))
    }

    private val deployLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val id = deployRequestId
        deployRequestId = -1
        if (id < 0) return@registerForActivityResult
        val json = result.data?.getStringExtra(DeployActivity.EXTRA_RESULT_JSON)
        if (result.resultCode == RESULT_OK && json != null) {
            reply(id, JSONObject().put("result", JSONObject(json)))
        } else {
            reply(id, JSONObject().put("cancelled", true))
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        Theming.applyStored(this)
        super.onCreate(savedInstanceState)
        Theming.applyBars(this)

        webView = WebView(this)
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.sozvon_bg))
        webView.settings.javaScriptEnabled = true
        // Our own files only: nothing here loads from the network, and the
        // page's CSP says so as well (connect-src 'none').
        webView.settings.allowContentAccess = false
        webView.addJavascriptInterface(Bridge(), "SozvonOnboarding")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !request.url.toString().startsWith("file:///android_asset/onboarding/")
        }
        setContentView(FrameLayout(this).apply { addView(webView, matchParent()) })
        webView.loadUrl(PAGE)

        // Back goes a step back inside the page; on its first screen it
        // leaves the app as Back always does.
        onBackPressedDispatcher.addCallback(this) {
            webView.evaluateJavascript("window.SozvonHost ? SozvonHost.back() : false") { handled ->
                if (handled != "true") {
                    setResult(RESULT_CANCELED)
                    finish()
                }
            }
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private fun matchParent() = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)

    private fun has(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    /** Answer the page's request [id].  Safe from any thread. */
    private fun reply(id: Int, value: JSONObject) {
        main.post {
            if (isDestroyed) return@post
            webView.evaluateJavascript(
                "SozvonHost._resolve($id, ${JSONObject.quote(value.toString())})", null)
        }
    }

    private fun ok() = JSONObject().put("ok", true)

    /**
     * What the page may ask.  Methods arrive on a WebView worker thread;
     * anything touching views or activities hops to the UI thread, anything
     * touching the network goes to a thread of its own.
     */
    inner class Bridge {
        @JavascriptInterface
        fun env(): String {
            val night = (resources.configuration.uiMode and
                Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
            return JSONObject()
                .put("lang", Locale.getDefault().toLanguageTag())
                .put("theme", if (night) "dark" else "light")
                .toString()
        }

        @JavascriptInterface
        fun call(id: Int, method: String, json: String) {
            val a = try {
                JSONObject(json)
            } catch (_: Exception) {
                JSONObject()
            }
            main.post { handle(id, method, a) }
        }
    }

    private fun handle(id: Int, method: String, a: JSONObject) {
        when (method) {
            "checkServer" -> Thread {
                reply(id, JSONObject().put("status", checkServer(a.optString("url"))))
            }.start()

            "media" -> reply(id, JSONObject().put("state",
                if (has(Manifest.permission.CAMERA) && has(Manifest.permission.RECORD_AUDIO))
                    "granted" else "prompt"))

            "requestMedia" -> {
                mediaRequestId = id
                permissionLauncher.launch(arrayOf(
                    Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO))
            }

            "openSettings" -> {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", packageName, null)))
                reply(id, ok())
            }

            "paste" -> {
                // Read only now, on the button press: Android 12+ announces
                // every clipboard read, and an unasked one is rightly suspect.
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val text = cm.primaryClip?.takeIf { it.itemCount > 0 }
                    ?.getItemAt(0)?.coerceToText(this)?.toString().orEmpty()
                reply(id, JSONObject().put("text", text))
            }

            "copy" -> {
                copy(a.optString("text"), a.optBoolean("sensitive"))
                reply(id, ok())
            }

            "share" -> {
                val send = Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_TEXT, a.optString("text"))
                startActivity(Intent.createChooser(send, null))
                reply(id, ok())
            }

            "deploy" -> {
                deployRequestId = id
                deployLauncher.launch(Intent(this, DeployActivity::class.java)
                    .putExtra(DeployActivity.EXTRA_ONBOARDING, true))
            }

            // The desktop's way back from its wizard; here the answer to
            // "deploy" arrives directly.
            "takeDeployResult" -> reply(id, JSONObject().put("cancelled", true))

            "mint" -> mint(id, a)

            "finish" -> {
                val url = a.optString("url")
                val origin = a.optString("origin")
                val u = Uri.parse(url)
                val o = Uri.parse(origin)
                // Only a secure address, and only on the server the page
                // says it is opening.
                if (u.scheme != "https" || u.host.isNullOrEmpty() ||
                    u.authority != o.authority
                ) {
                    reply(id, JSONObject().put("error", "bad address"))
                    return
                }
                markDone(this)
                setResult(RESULT_OK, Intent().putExtra(EXTRA_OPEN_URL, url))
                finish()
            }

            "skip" -> {
                markDone(this)
                setResult(RESULT_SKIPPED)
                finish()
            }

            else -> reply(id, JSONObject().put("error", "unknown method $method"))
        }
    }

    private fun copy(text: String, sensitive: Boolean) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Sozvon", text)
        if (sensitive) {
            // Keeps the password itself out of the preview Android 13+ shows.
            clip.description.extras = PersistableBundle().apply {
                putBoolean("android.content.extra.IS_SENSITIVE", true)
            }
        }
        cm.setPrimaryClip(clip)
    }

    // ------------------------------------------------------ server check ---

    /**
     * Whether there is a Sozvon server at [url]'s origin: "ok", "other" (it
     * answers but has no /healthz -- an upstream Galène, say), "unreachable",
     * "cert" or "cert-changed".  A host with a pinned certificate (one this
     * app installed with a self-signed certificate) is checked against that
     * pin and nothing else, exactly as the WebView will check it.
     */
    private fun checkServer(url: String): String {
        val origin = try {
            val u = URL(url)
            if (u.protocol != "https") return "unreachable"
            URL(u.protocol, u.host, u.port, "")
        } catch (_: Exception) {
            return "unreachable"
        }
        val pin = CertPins.get(this, origin.host)
        return try {
            val (code, body) = get(URL(origin, "/healthz"), pin)
            when {
                code == 200 && body.trim() == "ok" -> "ok"
                get(URL(origin, "/"), pin).first in 200..299 -> "other"
                else -> "unreachable"
            }
        } catch (e: SSLException) {
            if (pin != null) "cert-changed" else "cert"
        } catch (_: Exception) {
            "unreachable"
        }
    }

    private fun get(url: URL, pin: String?): Pair<Int, String> {
        val conn = url.openConnection() as HttpsURLConnection
        if (pin != null) conn.sslSocketFactory = pinnedContext(pin).socketFactory
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        try {
            val code = conn.responseCode
            val body = if (code in 200..299)
                conn.inputStream.bufferedReader().use { it.readText().take(64) } else ""
            return code to body
        } finally {
            conn.disconnect()
        }
    }

    /** Trust the system's authorities, or exactly the pinned certificate. */
    private fun pinnedContext(pin: String): SSLContext {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as KeyStore?)
        val system = tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
        val tm = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
                system.checkClientTrusted(chain, authType)

            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (chain.isNotEmpty() && CertPins.fingerprintOf(chain[0]) == pin) return
                system.checkServerTrusted(chain, authType)
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
        }
        return SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }
    }

    // -------------------------------------------------------------- mint ---

    /**
     * Make the first guest link on the server just installed.  The server
     * takes a websocket only from a page of its own, so the minter runs in a
     * hidden WebView opened at the server's /healthz, held to the same
     * certificate pins as the app's main WebView.  See onboarding/minter.js.
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun mint(id: Int, a: JSONObject) {
        val origin = try {
            val u = URL(a.optString("origin"))
            URL(u.protocol, u.host, u.port, "")
        } catch (_: Exception) {
            reply(id, JSONObject().put("ok", false).put("error", "bad origin"))
            return
        }
        val script = try {
            assets.open("onboarding/minter.js").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            reply(id, JSONObject().put("ok", false).put("error", "no minter"))
            return
        }
        val params = JSONObject()
            .put("group", a.optString("group"))
            .put("username", a.optString("username"))
            .put("password", a.optString("password"))
            .put("slug", a.optString("slug"))

        // Attached, but a pixel and invisible: a WebView left out of the
        // window may have its timers throttled.
        val hidden = WebView(this)
        hidden.visibility = View.INVISIBLE
        (webView.parent as ViewGroup).addView(hidden, FrameLayout.LayoutParams(1, 1))
        hidden.settings.javaScriptEnabled = true

        var answered = false
        val started = System.currentTimeMillis()
        fun done(value: JSONObject) {
            if (answered) return
            answered = true
            reply(id, value)
            main.post {
                (hidden.parent as? ViewGroup)?.removeView(hidden)
                hidden.destroy()
            }
        }
        fun poll() {
            if (answered || isDestroyed) return
            if (System.currentTimeMillis() - started > 30_000) {
                done(JSONObject().put("ok", false).put("error", "timeout"))
                return
            }
            hidden.evaluateJavascript("JSON.stringify(window.__sozvonMint || null)") { raw ->
                // evaluateJavascript hands back a JSON-encoded string.
                val s = try {
                    org.json.JSONTokener(raw).nextValue() as? String
                } catch (_: Exception) {
                    null
                }
                if (s != null && s != "null") done(JSONObject(s))
                else main.postDelayed({ poll() }, 300)
            }
        }

        var injected = false
        hidden.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                if (injected) return
                injected = true
                view.evaluateJavascript("$script\n;sozvonMint($params);void 0", null)
                poll()
            }

            override fun onReceivedSslError(
                view: WebView, handler: SslErrorHandler, error: SslError,
            ) {
                val host = Uri.parse(error.url).host.orEmpty()
                if (host.isNotEmpty() && CertPins.matches(this@OnboardingActivity, host, error.certificate)) {
                    handler.proceed()
                } else {
                    handler.cancel()
                    done(JSONObject().put("ok", false).put("error", "certificate"))
                }
            }
        }
        hidden.loadUrl(URL(origin, "/healthz").toString())
    }
}
