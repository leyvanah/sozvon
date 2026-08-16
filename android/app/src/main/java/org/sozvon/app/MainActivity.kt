package org.sozvon.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.PopupMenu
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.sozvon.app.deploy.CertPins

/**
 * A thin shell around the Sozvon web client.
 *
 * The first run asks for the server address (any self-hosted Sozvon/Galène
 * instance over https); subsequent launches go straight to the web client in
 * a WebView.  Every server the app has been to is kept (see [ServerStore]) and
 * listed on the address screen, so using a second one does not cost you the
 * first.  The app's job beyond that is the plumbing a browser
 * would otherwise provide: camera/microphone permissions, keeping the screen
 * on during calls, and downloads.  The "Change server" launcher shortcut
 * brings the address screen back.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_CHANGE_SERVER = "org.sozvon.app.CHANGE_SERVER"
        /** DeployActivity hands back the address of the server it just set up. */
        const val EXTRA_DEPLOYED_URL = "org.sozvon.app.DEPLOYED_URL"
    }

    /** Returning from "deploy your own server" with a freshly installed one. */
    private val deployLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode != RESULT_OK) return@registerForActivityResult
        // A server that has just been deleted from its machine: its card would
        // point at nothing, so it goes as well.  The list is this app's memory
        // of servers that exist.
        result.data?.getStringExtra(DeployActivity.EXTRA_REMOVED_URL)
            ?.takeIf { it.isNotBlank() }?.let { gone ->
                ServerStore.remove(this, gone)
                urlEdit.setText(ServerStore.mostRecent(this)?.url ?: "")
                renderServers()
                Toast.makeText(this, R.string.remove_done_toast, Toast.LENGTH_SHORT)
                    .show()
                return@registerForActivityResult
            }
        val url = result.data?.getStringExtra(EXTRA_DEPLOYED_URL)
        if (!url.isNullOrBlank()) {
            urlEdit.setText(url)
            // A server you installed joins the list under its host name; it
            // must not cost you the server you were using before.
            ServerStore.remember(this, url, Uri.parse(url).host.orEmpty())
            openServer(url)
        }
    }

    private lateinit var webView: WebView
    private lateinit var entry: View
    private lateinit var urlEdit: EditText
    private lateinit var entryError: TextView
    private lateinit var serversTitle: TextView
    private lateinit var serversList: LinearLayout

    /** A getUserMedia request waiting for the user to answer the Android
     *  permission dialog. */
    private var pendingPermissionRequest: PermissionRequest? = null

    /** The view a page asked us to show fullscreen (e.g. a tapped video tile),
     *  and the callback to notify when we tear it back down.  A bare WebView
     *  ignores the HTML5 fullscreen API unless the activity hosts the view, so
     *  without this the video controls' fullscreen button does nothing. */
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

    /** Forces call audio to the loudspeaker (or a headset) instead of the
     *  earpiece while a call is active.  Driven by the web client through the
     *  SozvonApp.setInCall() bridge. */
    private val audioRouter by lazy { AudioRouter(this) }

    /** Whether the web client reports a call in progress, so a back press can
     *  ask before dropping one. */
    private var inCall = false

    /** Set while opening a server, and acted on once its page has loaded.
     *  One WebView serves every server the user visits, so its history piles
     *  up across them -- including the about:blank each departure leaves
     *  behind.  Back would then walk through a blank screen and back into a
     *  server that had already been left, instead of leaving this one. */
    private var clearHistoryOnLoad = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        val request = pendingPermissionRequest ?: return@registerForActivityResult
        pendingPermissionRequest = null
        grantWebPermissions(request)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Before the content view: applying it afterwards recreates the
        // activity, which the user sees as a flash of the wrong theme.
        Theming.applyStored(this)
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        Theming.applyBars(this)

        // calls should not be interrupted by the screen timing out
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = findViewById(R.id.webview)
        entry = findViewById(R.id.entry)
        urlEdit = findViewById(R.id.server_url)
        entryError = findViewById(R.id.entry_error)
        serversTitle = findViewById(R.id.servers_title)
        serversList = findViewById(R.id.servers)

        setupWebView()

        findViewById<Button>(R.id.connect).setOnClickListener { connectFromEntry() }
        findViewById<TextView>(R.id.deploy_cta).setOnClickListener {
            deployLauncher.launch(Intent(this, DeployActivity::class.java))
        }
        findViewById<TextView>(R.id.reset_login).setOnClickListener {
            resetLoginData(false)
            Toast.makeText(this, R.string.reset_login_done, Toast.LENGTH_SHORT)
                .show()
        }
        urlEdit.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                connectFromEntry()
                true
            } else {
                false
            }
        }

        onBackPressedDispatcher.addCallback(this) {
            if (hideFullscreen())
                return@addCallback   // first back press leaves fullscreen video
            if (webView.visibility != View.VISIBLE) {
                moveTaskToBack(true)  // already on the server list
                return@addCallback
            }
            if (webView.canGoBack()) {
                webView.goBack()
                return@addCallback
            }
            // At the server's first page, back means "out of this server".
            // It used to send the app to the background instead, which left
            // no way back to the server list at all -- the only ways out were
            // the launcher shortcut and a link inside the web client's own
            // settings, neither of which is where anyone looks.
            if (inCall) {
                // Leaving would drop the call, and back is easy to press by
                // accident, so make the choice explicit.  Staying in the call
                // with the app in the background is the old behaviour, and
                // remains the default action.
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(R.string.leave_server_in_call)
                    .setPositiveButton(R.string.leave_server) { _, _ -> leaveServer() }
                    .setNegativeButton(R.string.leave_server_background) { _, _ ->
                        moveTaskToBack(true)
                    }
                    .show()
            } else {
                leaveServer()
            }
        }

        if (!handleDeepLink(intent)) {
            val saved = ServerStore.mostRecent(this)?.url
            if (saved != null &&
                !intent.getBooleanExtra(EXTRA_CHANGE_SERVER, false)
            ) {
                openServer(saved)
            } else {
                urlEdit.setText(saved ?: "")
                showEntry()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (handleDeepLink(intent))
            return
        if (intent.getBooleanExtra(EXTRA_CHANGE_SERVER, false)) {
            webView.loadUrl("about:blank")
            urlEdit.setText(ServerStore.mostRecent(this)?.url ?: "")
            showEntry()
        }
    }

    /** Handle an "open in app" deep link of the form sozvon://open?u=<https url>
     *  (or no u, to reopen the saved server).  Returns true if it opened one,
     *  so the normal launch path is skipped. */
    private fun handleDeepLink(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        if (!"sozvon".equals(data.scheme, ignoreCase = true))
            return false
        val target = data.getQueryParameter("u")?.trim().orEmpty()
        val url = when {
            target.isEmpty() ->
                ServerStore.mostRecent(this)?.url ?: return false
            target.contains("://") -> target
            else -> "https://$target"
        }
        // WebRTC needs a secure context, so only https is accepted here.
        if (!url.startsWith("https://") || Uri.parse(url).host.isNullOrEmpty())
            return false
        ServerStore.remember(this, url)
        openServer(url)
        return true
    }

    override fun onDestroy() {
        audioRouter.setActive(false)
        webView.destroy()
        super.onDestroy()
    }

    /**
     * Back to the server list.  The page is dropped rather than merely hidden:
     * a WebView left loaded keeps its call, its camera and its microphone, and
     * the user who asked to leave has no way to see or stop it.
     */
    private fun leaveServer() {
        webView.loadUrl("about:blank")
        inCall = false
        urlEdit.setText(ServerStore.mostRecent(this)?.url ?: "")
        showEntry()
    }

    private fun showEntry() {
        // Back on the address screen: no call is running, so drop any forced
        // speaker routing.
        audioRouter.setActive(false)
        entry.visibility = View.VISIBLE
        webView.visibility = View.GONE
        entryError.visibility = View.GONE
        renderServers()
        urlEdit.requestFocus()
    }

    /**
     * The saved-server cards under the address field.  Rebuilt whenever the
     * screen is shown or the list changes -- a handful of rows, so a RecyclerView
     * would be scaffolding around nothing.
     */
    private fun renderServers() {
        val servers = ServerStore.list(this)
        serversList.removeAllViews()
        serversTitle.visibility = if (servers.isEmpty()) View.GONE else View.VISIBLE
        val inflater = layoutInflater
        for (server in servers) {
            val card = inflater.inflate(R.layout.item_server, serversList, false)
            card.findViewById<TextView>(R.id.server_name).text = server.label
            card.findViewById<TextView>(R.id.server_address).text = server.url
            // A server whose certificate we pinned when installing it: worth
            // saying, since that pin is what makes a self-signed one reachable.
            val host = Uri.parse(server.url).host.orEmpty()
            if (host.isNotEmpty() && CertPins.get(this, host) != null) {
                card.findViewById<TextView>(R.id.server_pinned).visibility = View.VISIBLE
            }
            card.findViewById<View>(R.id.server_main).setOnClickListener {
                ServerStore.remember(this, server.url)
                urlEdit.setText(server.url)
                openServer(server.url)
            }
            card.findViewById<View>(R.id.server_menu).setOnClickListener { anchor ->
                showServerMenu(anchor, server)
            }
            serversList.addView(card)
        }
    }

    private fun showServerMenu(anchor: View, server: ServerStore.Server) {
        val menu = PopupMenu(this, anchor)
        menu.menu.add(0, 1, 0, R.string.server_rename)
        menu.menu.add(0, 2, 1, R.string.server_remove)
        // Reaching the machine itself, not just this app's list of it.
        menu.menu.add(0, 3, 2, R.string.server_reinstall)
        menu.menu.add(0, 4, 3, R.string.server_clean)
        menu.menu.add(0, 5, 4, R.string.server_delete)
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> { renameServer(server); true }
                2 -> { confirmRemoveServer(server); true }
                3 -> { manageServer(server, DeployActivity.MODE_REINSTALL); true }
                4 -> { manageServer(server, DeployActivity.MODE_CLEAN); true }
                5 -> { manageServer(server, DeployActivity.MODE_REMOVE); true }
                else -> false
            }
        }
        menu.show()
    }

    /**
     * Open the deploy screen against a server that already exists -- to
     * install over it, to wipe and install, or to take it off the machine.
     *
     * Only the address is carried over: the app never stores SSH credentials,
     * so that screen asks for them again, every time.
     */
    private fun manageServer(server: ServerStore.Server, mode: String) {
        val host = Uri.parse(server.url).host.orEmpty()
        deployLauncher.launch(
            Intent(this, DeployActivity::class.java)
                .putExtra(DeployActivity.EXTRA_MODE, mode)
                .putExtra(DeployActivity.EXTRA_HOST, host)
                .putExtra(DeployActivity.EXTRA_SERVER_URL, server.url)
        )
    }

    private fun renameServer(server: ServerStore.Server) {
        val input = EditText(this).apply {
            setText(server.name)
            setHint(R.string.server_rename_hint)
            setSingleLine()
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.server_rename)
            .setView(input)
            .setPositiveButton(R.string.common_save) { _, _ ->
                ServerStore.rename(this, server.url, input.text.toString())
                renderServers()
            }
            .setNegativeButton(R.string.common_cancel, null)
            .show()
    }

    private fun confirmRemoveServer(server: ServerStore.Server) {
        AlertDialog.Builder(this)
            .setMessage(getString(R.string.server_remove_confirm, server.label))
            .setPositiveButton(R.string.server_remove) { _, _ ->
                ServerStore.remove(this, server.url)
                renderServers()
            }
            .setNegativeButton(R.string.common_cancel, null)
            .show()
    }

    private fun showError(resId: Int) {
        entryError.setText(resId)
        entryError.visibility = View.VISIBLE
    }

    private fun connectFromEntry() {
        var url = urlEdit.text.toString().trim()
        if (url.isEmpty()) {
            showError(R.string.error_url)
            return
        }
        if (!url.contains("://"))
            url = "https://$url"
        // WebRTC needs a secure context, so only https makes sense here.
        if (!url.startsWith("https://")) {
            showError(R.string.error_https)
            return
        }
        if (Uri.parse(url).host.isNullOrEmpty()) {
            showError(R.string.error_url)
            return
        }
        ServerStore.remember(this, url)
        openServer(url)
    }

    private fun openServer(url: String) {
        entry.visibility = View.GONE
        webView.visibility = View.VISIBLE
        // A fresh page reports its own call state; until it does, there is no
        // call to warn about.
        inCall = false
        // Where this server starts is where back should leave from: whatever
        // came before belongs to a server the user has already left.
        clearHistoryOnLoad = true
        webView.loadUrl(url)
    }

    /** Reset the saved web login: the "remember me" token lives in the page's
     *  own storage, so wipe the WebView's storage and cookies.  Reload the
     *  server afterwards (in-app reset) so it re-prompts; on the entry screen
     *  there is nothing loaded, so stay put. */
    private fun resetLoginData(reload: Boolean) {
        WebStorage.getInstance().deleteAllData()
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        webView.clearCache(true)
        if (reload)
            ServerStore.mostRecent(this)?.let { openServer(it.url) }
    }

    /** Bridge the in-app web client calls for app-level settings.  Methods
     *  arrive on a WebView worker thread, so hop back to the UI thread. */
    inner class SozvonBridge {
        @JavascriptInterface
        fun changeServer() = runOnUiThread {
            webView.loadUrl("about:blank")
            urlEdit.setText(ServerStore.mostRecent(this@MainActivity)?.url ?: "")
            showEntry()
        }

        @JavascriptInterface
        fun resetLogin() = runOnUiThread { resetLoginData(true) }

        /** The web client reports whether a call is active so we can route its
         *  audio to the loudspeaker instead of the earpiece -- and so that a
         *  back press knows whether leaving would drop a call. */
        @JavascriptInterface
        fun setInCall(active: Boolean) = runOnUiThread {
            inCall = active
            audioRouter.setActive(active)
        }

        /** The client reports which appearance the user chose — "system",
         *  "light" or "dark" — so the status bar, the server list and the
         *  deploy wizard match the page instead of staying dark behind it.
         *  The bars follow at once; the rest waits for the next time those
         *  screens are created, because switching the mode outright would
         *  recreate this activity and take the call down with it. */
        @JavascriptInterface
        fun setTheme(pref: String?) = runOnUiThread {
            Theming.store(this@MainActivity, pref)
            Theming.applyBars(this@MainActivity, pref)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            // The web client hides its own "download the app" button when it
            // sees this marker.
            userAgentString = "$userAgentString SozvonApp/${BuildConfig.VERSION_NAME}"
        }

        // Lets the in-app web client offer app-level settings (change server,
        // reset the saved login). Only our own server is ever loaded in this
        // WebView — off-server links open in the system browser — so the bridge
        // is reachable only from the trusted origin, and both calls are benign.
        webView.addJavascriptInterface(SozvonBridge(), "SozvonApp")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val needed = mutableListOf<String>()
                for (resource in request.resources) {
                    when (resource) {
                        PermissionRequest.RESOURCE_VIDEO_CAPTURE ->
                            if (!hasPermission(Manifest.permission.CAMERA))
                                needed += Manifest.permission.CAMERA
                        PermissionRequest.RESOURCE_AUDIO_CAPTURE ->
                            if (!hasPermission(Manifest.permission.RECORD_AUDIO))
                                needed += Manifest.permission.RECORD_AUDIO
                    }
                }
                if (needed.isEmpty()) {
                    grantWebPermissions(request)
                } else {
                    pendingPermissionRequest = request
                    permissionLauncher.launch(needed.toTypedArray())
                }
            }

            override fun onShowCustomView(
                view: View,
                callback: CustomViewCallback,
            ) {
                showFullscreen(view, callback)
            }

            override fun onHideCustomView() {
                hideFullscreen()
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                // Stay in the app for anything on the server whose page is
                // doing the navigating.  This used to compare against the one
                // saved address, which is not necessarily the server on
                // screen -- now that several are remembered it would be wrong
                // more often, and it sends a link the user tapped in a call
                // out to a browser.
                val server = Uri.parse(view.url ?: "").host
                    ?: ServerStore.mostRecent(this@MainActivity)
                        ?.let { Uri.parse(it.url).host }
                if (server != null && request.url.host == server)
                    return false
                // anything off the server opens in the system browser
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    true
                } catch (e: Exception) {
                    false
                }
            }

            /**
             * Drop what the previous server left in the back/forward list,
             * once the new one is actually on screen.  clearHistory() keeps
             * the current entry, so this leaves exactly the page we opened --
             * and back from it means "leave this server", as it reads.
             *
             * A redirect (the hub sends an operator on to its dashboard)
             * finishes on the page that matters, which is where we want the
             * history to start.
             */
            override fun onPageFinished(view: WebView, url: String) {
                if (clearHistoryOnLoad && url != "about:blank") {
                    clearHistoryOnLoad = false
                    view.clearHistory()
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (request.isForMainFrame) {
                    showEntry()
                    showError(R.string.error_load)
                }
            }

            /**
             * A server set up with the self-signed TLS mode presents a
             * certificate no authority vouches for.  We accept it only when
             * it is byte-for-byte the certificate whose fingerprint was
             * reported when this app installed that server -- the user
             * watched it being generated over their own SSH session.
             *
             * Anything else is refused.  Proceeding on an unpinned or
             * mismatched certificate would mean trusting whoever answers for
             * the address, which is precisely what TLS is for; a mismatch on
             * a host we *do* have a pin for is the interesting case, because
             * it means the certificate changed under us.
             */
            override fun onReceivedSslError(
                view: WebView,
                handler: SslErrorHandler,
                error: SslError,
            ) {
                val host = try {
                    Uri.parse(error.url).host.orEmpty()
                } catch (_: Exception) {
                    ""
                }
                if (host.isNotEmpty() &&
                    CertPins.matches(this@MainActivity, host, error.certificate)
                ) {
                    handler.proceed()
                    return
                }
                handler.cancel()
                showEntry()
                showError(
                    if (host.isNotEmpty() && CertPins.get(this@MainActivity, host) != null)
                        R.string.error_cert_changed
                    else
                        R.string.error_cert_untrusted
                )
            }
        }

        // recordings and other files offered by the web client
        webView.setDownloadListener { url, _, contentDisposition, mimetype, _ ->
            try {
                val request = DownloadManager.Request(Uri.parse(url))
                    .setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS,
                        URLUtil.guessFileName(url, contentDisposition, mimetype))
                getSystemService(DownloadManager::class.java).enqueue(request)
            } catch (e: Exception) {
                // missing storage permission on old Androids: just skip
            }
        }
    }

    private fun hasPermission(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) ==
            PackageManager.PERMISSION_GRANTED

    /** Grant the page exactly those capture resources whose Android-side
     *  permission the user has approved. */
    private fun grantWebPermissions(request: PermissionRequest) {
        val grantable = request.resources.filter { resource ->
            when (resource) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE ->
                    hasPermission(Manifest.permission.CAMERA)
                PermissionRequest.RESOURCE_AUDIO_CAPTURE ->
                    hasPermission(Manifest.permission.RECORD_AUDIO)
                else -> false
            }
        }.toTypedArray()
        if (grantable.isEmpty())
            request.deny()
        else
            request.grant(grantable)
    }

    /** Host a page's fullscreen view (a tapped video tile) over the WebView and
     *  go edge-to-edge while it is up. */
    private fun showFullscreen(
        view: View,
        callback: WebChromeClient.CustomViewCallback,
    ) {
        if (fullscreenView != null) {
            callback.onCustomViewHidden()
            return
        }
        fullscreenView = view
        fullscreenCallback = callback
        webView.visibility = View.GONE
        (window.decorView as FrameLayout).addView(
            view,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        applyImmersive(true)
    }

    /** Tear the fullscreen view back down.  Returns true if one was showing, so
     *  the back button can consume the press instead of leaving the call. */
    private fun hideFullscreen(): Boolean {
        val view = fullscreenView ?: return false
        (window.decorView as FrameLayout).removeView(view)
        fullscreenView = null
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        webView.visibility = View.VISIBLE
        applyImmersive(false)
        return true
    }

    private fun applyImmersive(on: Boolean) {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (on) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior = WindowInsetsControllerCompat
                .BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }
}
