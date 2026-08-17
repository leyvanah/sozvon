package org.sozvon.app

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import android.text.InputType
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import org.sozvon.app.deploy.CertPins
import org.sozvon.app.deploy.SshDeployer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * "Deploy your own server": asks for a VPS and its SSH credentials, then runs
 * the Sozvon installer on it and hands back the address and operator password.
 *
 * The work happens on a plain background thread.  The install itself is
 * detached on the server and followed by polling, so a phone that sleeps or
 * changes network mid-install does not abort it.
 */
class DeployActivity : AppCompatActivity() {

    companion object {
        private const val PREFS = "sozvon"
        private const val KEY_HOSTKEYS = "known_host_keys"
        /** TLS modes in the order they appear in the spinner. */
        private val TLS_MODES = listOf(
            "letsencrypt-sslip", "letsencrypt-domain", "self-signed")

        /** What this screen is being opened for. */
        const val EXTRA_MODE = "org.sozvon.app.DEPLOY_MODE"
        /** Prefill, for a server the app already knows. */
        const val EXTRA_HOST = "org.sozvon.app.DEPLOY_HOST"
        /** Which saved server this is, so a removal can report it back. */
        const val EXTRA_SERVER_URL = "org.sozvon.app.DEPLOY_SERVER_URL"
        /** Result: Sozvon is no longer installed at this address. */
        const val EXTRA_REMOVED_URL = "org.sozvon.app.REMOVED_URL"

        /** A server that does not exist yet. */
        const val MODE_INSTALL = "install"
        /** Run the installer over an existing one: new version, same rooms. */
        const val MODE_REINSTALL = "reinstall"
        /** Delete everything, then install as if the machine were new. */
        const val MODE_CLEAN = "clean"
        /** Take Sozvon off the server, with or without its data. */
        const val MODE_REMOVE = "remove"
    }

    private var mode = MODE_INSTALL
    private var serverUrl: String? = null

    /** What the install running now was told, kept for the server list. */
    private var lastDeploy: ServerStore.Deploy? = null

    private lateinit var viewForm: View
    private lateinit var viewProgress: View
    private lateinit var viewDone: View
    private lateinit var viewError: View

    private var worker: Thread? = null
    private var result: JSONObject? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        Theming.applyStored(this)
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_deploy)
        Theming.applyBars(this)

        viewForm = findViewById(R.id.deploy_form)
        viewProgress = findViewById(R.id.deploy_progress)
        viewDone = findViewById(R.id.deploy_done)
        viewError = findViewById(R.id.deploy_error)

        val tls = findViewById<Spinner>(R.id.tls_mode)
        tls.adapter = ArrayAdapter.createFromResource(
            this, R.array.tls_modes, android.R.layout.simple_spinner_item
        ).apply {
            setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        }
        tls.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                findViewById<View>(R.id.domain_row).visibility =
                    if (TLS_MODES[pos] == "letsencrypt-domain") View.VISIBLE else View.GONE
                findViewById<TextView>(R.id.tls_hint).setText(
                    when (TLS_MODES[pos]) {
                        "letsencrypt-sslip" -> R.string.tls_hint_sslip
                        "letsencrypt-domain" -> R.string.tls_hint_domain
                        else -> R.string.tls_hint_selfsigned
                    }
                )
            }
            override fun onNothingSelected(p: AdapterView<*>?) = Unit
        }

        // Deliberately not written with apply {}: inside it, an unqualified
        // findViewById would resolve against the Spinner and search only its
        // own subtree, quietly returning null for these rows.
        val auth = findViewById<Spinner>(R.id.auth_type)
        auth.adapter = ArrayAdapter.createFromResource(
            this, R.array.auth_types, android.R.layout.simple_spinner_item
        ).apply {
            setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        }
        auth.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                findViewById<View>(R.id.password_row).visibility =
                    if (pos == 0) View.VISIBLE else View.GONE
                findViewById<View>(R.id.key_row).visibility =
                    if (pos == 1) View.VISIBLE else View.GONE
            }
            override fun onNothingSelected(p: AdapterView<*>?) = Unit
        }

        wireReveal(R.id.ssh_password, R.id.ssh_password_reveal)
        wireReveal(R.id.ssh_passphrase, R.id.ssh_passphrase_reveal)

        // The bundled-release choice only exists if this build has one to
        // offer.  Showing an unchecked, unusable box would be worse than
        // showing nothing: it would suggest the app could do something it
        // cannot.
        val bundled = bundledRelease()
        val bundledBox = findViewById<CheckBox>(R.id.use_bundled)
        if (bundled == null) {
            findViewById<View>(R.id.use_bundled_row).visibility = View.GONE
        } else {
            bundledBox.text = getString(R.string.deploy_use_bundled, bundled.version)
            bundledBox.isChecked = true
        }

        mode = intent.getStringExtra(EXTRA_MODE) ?: MODE_INSTALL
        serverUrl = intent.getStringExtra(EXTRA_SERVER_URL)
        intent.getStringExtra(EXTRA_HOST)?.takeIf { it.isNotBlank() }?.let {
            findViewById<EditText>(R.id.ssh_host).setText(it)
        }
        applyMode()
        prefillFromLastDeploy()

        findViewById<Button>(R.id.deploy_go).setOnClickListener { start() }
        findViewById<Button>(R.id.deploy_back).setOnClickListener { finish() }
        findViewById<Button>(R.id.deploy_retry).setOnClickListener { show(viewForm) }
        findViewById<Button>(R.id.deploy_open).setOnClickListener { openInstalled() }

        show(viewForm)
    }

    /**
     * One screen, four errands against one machine: install, install over,
     * wipe and install, remove.  They differ in what the screen says and which
     * fields it needs -- not in how they reach the server, which is why they
     * share it.  The SSH credentials are asked for every time: the app never
     * stores them, so there is nothing to reuse from the install.
     */
    private fun applyMode() {
        val title = findViewById<TextView>(R.id.form_title)
        val subtitle = findViewById<TextView>(R.id.form_subtitle)
        val go = findViewById<Button>(R.id.deploy_go)
        when (mode) {
            MODE_REINSTALL -> {
                title.setText(R.string.reinstall_title)
                subtitle.setText(R.string.reinstall_subtitle)
                go.setText(R.string.reinstall_go)
            }
            MODE_CLEAN -> {
                title.setText(R.string.clean_title)
                subtitle.setText(R.string.clean_subtitle)
                go.setText(R.string.clean_go)
            }
            MODE_REMOVE -> {
                title.setText(R.string.remove_title)
                subtitle.setText(R.string.remove_subtitle)
                go.setText(R.string.remove_go)
                // Nothing is being installed, so none of the install options
                // apply.  What does apply is how much to delete.
                findViewById<View>(R.id.install_only).visibility = View.GONE
                findViewById<View>(R.id.remove_row).visibility = View.VISIBLE
                findViewById<CheckBox>(R.id.purge_data).setOnCheckedChangeListener { _, on ->
                    findViewById<TextView>(R.id.remove_hint).setText(
                        if (on) R.string.remove_purge_hint else R.string.remove_keep_hint)
                }
            }
            else -> Unit   // the install screen as it was
        }
    }

    /**
     * Fill the form with what this server was installed with.
     *
     * Reinstalling from the fields' defaults is how a server quietly changes
     * certificate mode, room name or port: the defaults describe a *new*
     * install, not this one.  Only settings are restored -- the SSH password
     * and key are credentials and were never stored, so they are asked for
     * again.
     *
     * Nothing to restore (a server added by typing its address, or installed
     * by an older build) leaves the defaults alone.
     */
    private fun prefillFromLastDeploy() {
        if (mode == MODE_INSTALL) return
        val url = serverUrl ?: return
        val d = ServerStore.list(this)
            .firstOrNull { it.url.trimEnd('/').equals(url.trimEnd('/'), true) }
            ?.deploy ?: return

        findViewById<EditText>(R.id.ssh_port).setText(d.sshPort.toString())
        findViewById<EditText>(R.id.ssh_user).setText(d.sshUser)
        // Setting the spinner runs its listener, which shows the domain field
        // and the hint that goes with the mode.
        TLS_MODES.indexOf(d.tls).takeIf { it >= 0 }?.let {
            findViewById<Spinner>(R.id.tls_mode).setSelection(it)
        }
        findViewById<EditText>(R.id.ssh_domain).setText(d.domain)
        findViewById<EditText>(R.id.room_name).setText(d.group)
        findViewById<EditText>(R.id.https_port).setText(d.httpsPort?.toString() ?: "")
        findViewById<EditText>(R.id.mirror_url).setText(d.mirror)

        // Say that the fields describe this server, not a new one: otherwise
        // they look like defaults and editing one looks harmless.
        val subtitle = findViewById<TextView>(R.id.form_subtitle)
        subtitle.text = subtitle.text.toString() + "\n\n" +
            getString(R.string.reinstall_prefilled)
    }

    /**
     * The eye next to a password field.  A password typed blind on a phone
     * keyboard and never shown back is a password typed wrong -- and here the
     * mistake surfaces as an SSH authentication failure a stage into the
     * install, with nothing to check it against.
     *
     * Switching inputType resets the cursor, so it is put back where it was.
     */
    private fun wireReveal(fieldId: Int, buttonId: Int) {
        val field = findViewById<EditText>(fieldId)
        val button = findViewById<ImageButton>(buttonId)
        button.setOnClickListener {
            val hidden = field.inputType and InputType.TYPE_MASK_VARIATION ==
                InputType.TYPE_TEXT_VARIATION_PASSWORD
            val at = field.selectionEnd
            field.inputType = InputType.TYPE_CLASS_TEXT or if (hidden) {
                InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            } else {
                InputType.TYPE_TEXT_VARIATION_PASSWORD
            }
            field.setSelection(at.coerceIn(0, field.text.length))
            button.setImageResource(if (hidden) R.drawable.ic_eye_off else R.drawable.ic_eye)
            button.contentDescription =
                getString(if (hidden) R.string.password_hide else R.string.password_show)
        }
    }

    private fun show(v: View) {
        for (view in listOf(viewForm, viewProgress, viewDone, viewError)) {
            view.visibility = if (view === v) View.VISIBLE else View.GONE
        }
    }

    private fun text(id: Int) = findViewById<EditText>(id).text.toString().trim()

    private fun prefs() = getSharedPreferences(PREFS, MODE_PRIVATE)

    private fun knownKey(host: String, port: Int): String? =
        prefs().getString("$KEY_HOSTKEYS:$host:$port", null)

    private fun rememberKey(host: String, port: Int, fp: String) {
        prefs().edit().putString("$KEY_HOSTKEYS:$host:$port", fp).apply()
    }

    // ------------------------------------------------------------- start ---

    private fun start() {
        val host = text(R.id.ssh_host)
        if (host.isEmpty()) {
            findViewById<EditText>(R.id.ssh_host).requestFocus()
            return
        }
        val port = text(R.id.ssh_port).toIntOrNull() ?: 22
        val user = text(R.id.ssh_user).ifEmpty { "root" }
        val usingKey = findViewById<Spinner>(R.id.auth_type).selectedItemPosition == 1
        val password = if (usingKey) null else
            findViewById<EditText>(R.id.ssh_password).text.toString()
        val keyText = if (usingKey) text(R.id.ssh_key) else ""
        if (!usingKey && password.isNullOrEmpty()) {
            findViewById<EditText>(R.id.ssh_password).requestFocus()
            return
        }
        if (usingKey && keyText.isEmpty()) {
            findViewById<EditText>(R.id.ssh_key).requestFocus()
            return
        }

        if (mode == MODE_REMOVE) {
            val purge = findViewById<CheckBox>(R.id.purge_data).isChecked
            // Deleting someone's rooms, operator accounts and invite links on
            // the strength of one tap is not a thing to do quietly.
            AlertDialog.Builder(this)
                .setTitle(R.string.remove_title)
                .setMessage(getString(
                    if (purge) R.string.remove_confirm_purge
                    else R.string.remove_confirm_keep, host))
                .setPositiveButton(R.string.remove_go) { _, _ ->
                    runRemoval(host, port, user, password, usingKey, keyText, purge)
                }
                .setNegativeButton(R.string.common_cancel, null)
                .show()
            return
        }

        val tlsMode = TLS_MODES[findViewById<Spinner>(R.id.tls_mode).selectedItemPosition]
        val domain = text(R.id.ssh_domain)
        if (tlsMode == "letsencrypt-domain" && domain.isEmpty()) {
            findViewById<EditText>(R.id.ssh_domain).requestFocus()
            return
        }
        if (mode == MODE_CLEAN) {
            AlertDialog.Builder(this)
                .setTitle(R.string.clean_title)
                .setMessage(getString(R.string.clean_confirm, host))
                .setPositiveButton(R.string.clean_go) { _, _ ->
                    runInstall(host, port, user, password, usingKey, keyText,
                        tlsMode, domain, wipeFirst = true)
                }
                .setNegativeButton(R.string.common_cancel, null)
                .show()
            return
        }
        if (mode == MODE_REINSTALL) {
            // Say back what is about to be installed.  A reinstall that
            // silently switches certificate mode or port is the mistake this
            // screen is most likely to make, since those are fields with
            // defaults and the server has settings of its own.
            val tlsLabel = resources.getStringArray(R.array.tls_modes)
                .getOrElse(TLS_MODES.indexOf(tlsMode)) { tlsMode }
            AlertDialog.Builder(this)
                .setTitle(R.string.reinstall_title)
                .setMessage(getString(
                    R.string.reinstall_confirm, host, tlsLabel,
                    text(R.id.room_name).ifEmpty { "meet" },
                    text(R.id.https_port).ifEmpty { "443" }))
                .setPositiveButton(R.string.reinstall_go) { _, _ ->
                    runInstall(host, port, user, password, usingKey, keyText,
                        tlsMode, domain, wipeFirst = false)
                }
                .setNegativeButton(R.string.common_cancel, null)
                .show()
            return
        }
        runInstall(host, port, user, password, usingKey, keyText,
            tlsMode, domain, wipeFirst = false)
    }

    /**
     * Install: onto a machine with no Sozvon, or over one that has it.
     *
     * @param wipeFirst delete what is there first, so the result is what a
     *   first install would have produced -- a new operator password and no
     *   rooms -- rather than an upgrade that keeps them.
     */
    private fun runInstall(
        host: String, port: Int, user: String,
        password: String?, usingKey: Boolean, keyText: String,
        tlsMode: String, domain: String, wipeFirst: Boolean,
    ) {
        val group = text(R.id.room_name).ifEmpty { "meet" }
        val httpsPort = text(R.id.https_port).toIntOrNull()
        val mirror = text(R.id.mirror_url)
        // Unchecked means "fetch the current release from GitHub instead",
        // which is what the installer does on its own.  The box is hidden
        // altogether when this build carries no release to install.
        val useBundled = findViewById<CheckBox>(R.id.use_bundled).isChecked
        lastDeploy = ServerStore.Deploy(
            sshPort = port,
            sshUser = user,
            tls = tlsMode,
            domain = domain,
            group = group,
            httpsPort = httpsPort,
            mirror = mirror,
        )

        buildSteps()
        findViewById<TextView>(R.id.progress_sub).setText(R.string.deploy_connecting)
        show(viewProgress)

        val deployer = deployerFor(host, port, user, password, usingKey, keyText)
        val prompt = hostKeyPrompt(host, port)

        worker = Thread {
            try {
                deployer.connect(prompt)
                if (wipeFirst) {
                    // Including the group file: left in place, the installer
                    // keeps it, and with it the old operator password -- which
                    // is not what "clean" says on the button.
                    deployer.uninstall(purge = true) { p ->
                        runOnUiThread { onProgress(p) }
                    }
                }
                val res = deployer.deploy(
                    SshDeployer.Options(
                        tlsMode = tlsMode,
                        domain = domain.ifEmpty { null },
                        // ip is deliberately left unset: SshDeployer fills it
                        // from the address this deploy actually reached, and
                        // resolves it first if what was typed was a name.
                        // Setting it here as well is how it came to be passed
                        // as a hostname and refused by the installer.
                        group = group,
                        adminUser = "operator",
                        httpsPort = httpsPort,
                        mirror = mirror.ifEmpty { null },
                        useBundled = useBundled,
                    ),
                    prompt,
                ) { progress -> runOnUiThread { onProgress(progress) } }
                runOnUiThread { onSuccess(res) }
            } catch (e: SshDeployer.DeployException) {
                runOnUiThread { onFailure(e.message, e.detail) }
            } catch (e: Exception) {
                runOnUiThread { onFailure(e.message, null) }
            } finally {
                deployer.disconnect()
            }
        }.also { it.start() }
    }

    /** Every errand reaches the server the same way. */
    private fun deployerFor(
        host: String, port: Int, user: String,
        password: String?, usingKey: Boolean, keyText: String,
    ): SshDeployer = SshDeployer(
        host = host,
        port = port,
        username = user,
        password = password,
        privateKey = if (usingKey) keyText.toByteArray() else null,
        passphrase = findViewById<EditText>(R.id.ssh_passphrase)
            .text.toString().ifEmpty { null },
        installerScript = assets.open("install.sh").bufferedReader().use { it.readText() },
        knownFingerprint = knownKey(host, port),
        bundledRelease = bundledRelease(),
    )

    /**
     * The server release packed into this APK, or null if this build has none.
     *
     * Read from the assets that :app:fetchServerRelease writes before the
     * build: `latest` names the version, `SHA256SUMS` is the release's own
     * checksum file, and `manifest` lists the architectures actually shipped
     * with their sizes.  The manifest exists because an asset's size is not
     * reliably readable once it is inside the APK, and the upload wants a
     * total to count against.
     *
     * Any failure here means "this build has no bundled release", which is a
     * legitimate state -- the app then installs the way it always did, by
     * asking the server to download one.
     */
    private fun bundledRelease(): SshDeployer.BundledRelease? = try {
        val version = assets.open("server/latest")
            .bufferedReader().use { it.readText() }.trim()
        val sums = assets.open("server/SHA256SUMS")
            .bufferedReader().use { it.readText() }
        val sizes = assets.open("server/manifest").bufferedReader().use { r ->
            r.readLines().mapNotNull { line ->
                val parts = line.trim().split(" ")
                val size = parts.getOrNull(1)?.toLongOrNull()
                if (parts.size == 2 && size != null && size > 0)
                    parts[0] to size else null
            }.toMap()
        }
        if (version.isEmpty() || sizes.isEmpty()) null
        else SshDeployer.BundledRelease(
            version = version,
            sums = sums,
            openAsset = { path -> assets.open(path) },
            sizes = sizes,
        )
    } catch (e: Exception) {
        null
    }

    /** Take Sozvon off the server; with [purge], its rooms and accounts too. */
    private fun runRemoval(
        host: String, port: Int, user: String,
        password: String?, usingKey: Boolean, keyText: String, purge: Boolean,
    ) {
        findViewById<LinearLayout>(R.id.steps).removeAllViews()
        findViewById<TextView>(R.id.progress_sub).setText(R.string.deploy_connecting)
        show(viewProgress)

        val deployer = deployerFor(host, port, user, password, usingKey, keyText)
        val prompt = hostKeyPrompt(host, port)

        worker = Thread {
            try {
                deployer.connect(prompt)
                deployer.uninstall(purge) { p -> runOnUiThread { onProgress(p) } }
                runOnUiThread { onRemoved(purge) }
            } catch (e: SshDeployer.DeployException) {
                runOnUiThread { onFailure(e.message, e.detail) }
            } catch (e: Exception) {
                runOnUiThread { onFailure(e.message, null) }
            } finally {
                deployer.disconnect()
            }
        }.also { it.start() }
    }

    /**
     * The server is gone.  Its card would now point at nothing, so the address
     * goes back to MainActivity, which owns the list.
     */
    private fun onRemoved(purge: Boolean) {
        AlertDialog.Builder(this)
            .setMessage(if (purge) R.string.remove_done_purge else R.string.remove_done_keep)
            .setCancelable(false)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                setResult(RESULT_OK, Intent().putExtra(EXTRA_REMOVED_URL, serverUrl))
                finish()
            }
            .show()
    }

    /**
     * Confirming the server's SSH key.  Accepting one silently would hand root
     * on the user's server to whoever is in the middle, so the fingerprint is
     * shown, and a changed one says so loudly.
     */
    private fun hostKeyPrompt(host: String, port: Int) =
        object : SshDeployer.HostKeyPrompt {
            override fun confirm(
                fingerprint: String, changed: Boolean, previous: String?,
            ): Boolean {
                val latch = CountDownLatch(1)
                val accepted = AtomicBoolean(false)
                runOnUiThread {
                    val message = StringBuilder()
                    message.append(
                        if (changed) getString(R.string.hostkey_changed, host)
                        else getString(R.string.hostkey_new, host))
                    message.append("\n\n").append(fingerprint)
                    if (changed && previous != null) {
                        message.append("\n\n")
                            .append(getString(R.string.hostkey_previous))
                            .append("\n").append(previous)
                    }
                    message.append("\n\n").append(getString(R.string.hostkey_warning))
                    AlertDialog.Builder(this@DeployActivity)
                        .setTitle(R.string.hostkey_title)
                        .setMessage(message.toString())
                        .setCancelable(false)
                        .setPositiveButton(R.string.hostkey_trust) { _, _ ->
                            accepted.set(true)
                            rememberKey(host, port, fingerprint)
                            latch.countDown()
                        }
                        .setNegativeButton(R.string.common_cancel) { _, _ ->
                            latch.countDown()
                        }
                        .show()
                }
                latch.await()
                return accepted.get()
            }
        }

    // ---------------------------------------------------------- progress ---

    private fun buildSteps() {
        val container = findViewById<LinearLayout>(R.id.steps)
        container.removeAllViews()
        for (stage in SshDeployer.STAGES) {
            val tv = TextView(this)
            tv.text = "○  " + stageLabel(stage)
            tv.setTextColor(getColor(R.color.sozvon_text3))
            tv.textSize = 15f
            tv.setPadding(0, 12, 0, 12)
            tv.tag = stage
            container.addView(tv)
        }
    }

    private fun stageLabel(stage: String): String = getString(
        when (stage) {
            "preflight" -> R.string.stage_preflight
            "user" -> R.string.stage_user
            "fetch" -> R.string.stage_fetch
            "tls" -> R.string.stage_tls
            "config" -> R.string.stage_config
            "firewall" -> R.string.stage_firewall
            "service" -> R.string.stage_service
            "verify" -> R.string.stage_verify
            else -> R.string.stage_done
        }
    )

    private fun onProgress(p: SshDeployer.Progress) {
        when (p) {
            is SshDeployer.Progress.Phase -> {
                findViewById<TextView>(R.id.progress_sub).setText(
                    when (p.phase) {
                        "checking" -> R.string.phase_checking
                        "uploading" -> R.string.phase_uploading
                        "sending" -> R.string.phase_sending
                        "starting" -> R.string.phase_starting
                        "removing" -> R.string.phase_removing
                        else -> R.string.phase_installing
                    }
                )
            }
            is SshDeployer.Progress.Transfer -> {
                // Several megabytes over SSH: without a number moving, this
                // is the one step long enough to read as a hang.
                val pct =
                    if (p.total > 0) (p.sent * 100 / p.total).toInt().coerceIn(0, 100)
                    else 0
                findViewById<TextView>(R.id.progress_sub).text =
                    getString(R.string.phase_sending_pct, pct)
            }
            is SshDeployer.Progress.Stage -> {
                val at = SshDeployer.STAGES.indexOf(p.stage)
                val container = findViewById<LinearLayout>(R.id.steps)
                for (i in 0 until container.childCount) {
                    val tv = container.getChildAt(i) as? TextView ?: continue
                    val label = stageLabel(SshDeployer.STAGES[i])
                    when {
                        at < 0 -> {}
                        i < at -> {
                            tv.text = "●  $label"
                            tv.setTextColor(getColor(R.color.sozvon_ok))
                        }
                        i == at -> {
                            tv.text = "◐  $label"
                            tv.setTextColor(getColor(R.color.sozvon_text))
                        }
                        else -> {
                            tv.text = "○  $label"
                            tv.setTextColor(getColor(R.color.sozvon_text3))
                        }
                    }
                }
                findViewById<TextView>(R.id.progress_sub).text =
                    getString(R.string.deploy_step_of, p.index, p.total)
            }
        }
    }

    private fun onSuccess(res: JSONObject) {
        result = res
        // A self-signed server is only reachable afterwards because we pin the
        // certificate the installer just generated.  This is the one moment we
        // can trust it: it came back over our own authenticated SSH session,
        // from a server we just set up ourselves.
        val fp = res.optString("cert_sha256")
        val host = res.optString("hostname")
        if (res.optString("tls_mode") == "self-signed" &&
            fp.isNotEmpty() && host.isNotEmpty()
        ) {
            CertPins.put(this, host, fp)
        }
        findViewById<TextView>(R.id.result_url).text = res.optString("url")
        findViewById<TextView>(R.id.result_user).text = res.optString("admin_user")
        val pw = res.optString("admin_password")
        findViewById<TextView>(R.id.result_password).text =
            if (pw.isEmpty()) getString(R.string.result_password_unchanged) else pw
        // This screen is the only time the password is ever shown, so getting
        // it out of here has to be one tap.  The button is hidden when there
        // is nothing to copy -- a reinstall keeps the old password and shows
        // "(unchanged)", which is not a password. (Sozvon)
        val copyBtn = findViewById<ImageButton>(R.id.result_password_copy)
        if (pw.isEmpty()) {
            copyBtn.visibility = View.GONE
        } else {
            copyBtn.visibility = View.VISIBLE
            copyBtn.setOnClickListener {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                // Labelled sensitive so Android 13+ does not put the password
                // itself in the clipboard preview toast it shows over the app.
                val clip = ClipData.newPlainText(
                    getString(R.string.result_password), pw
                ).apply {
                    description.extras = PersistableBundle().apply {
                        putBoolean("android.content.extra.IS_SENSITIVE", true)
                    }
                }
                cm.setPrimaryClip(clip)
                // Android 13+ shows its own confirmation, so a toast here would
                // be the second one.
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                    Toast.makeText(this, R.string.result_copied, Toast.LENGTH_SHORT)
                        .show()
                }
            }
        }
        if (res.optString("tls_mode") == "self-signed") {
            findViewById<View>(R.id.result_selfsigned).visibility = View.VISIBLE
            findViewById<TextView>(R.id.result_fingerprint).text =
                "SHA-256: " + res.optString("cert_sha256")
        }
        // Remember how this server was installed, so reinstalling it later
        // offers what it actually runs rather than the defaults for a new
        // machine.  Keyed by the origin, which is what the server list holds.
        lastDeploy?.let { d ->
            val origin = res.optString("origin").ifEmpty {
                val u = res.optString("url")
                if (u.startsWith("https://")) u.substringBefore("/group/").trimEnd('/')
                else "https://$host"
            }
            if (origin.isNotEmpty()) {
                ServerStore.rememberDeploy(this, origin, host, d)
            }
        }
        show(viewDone)
    }

    private fun onFailure(message: String?, detail: String?) {
        findViewById<TextView>(R.id.error_message).text =
            message ?: getString(R.string.deploy_failed)
        val d = findViewById<TextView>(R.id.error_detail)
        if (detail.isNullOrBlank()) {
            d.visibility = View.GONE
        } else {
            d.visibility = View.VISIBLE
            d.text = detail
        }
        show(viewError)
    }

    private fun openInstalled() {
        val res = result ?: return
        // Hand the address back to MainActivity, which owns the WebView and
        // the stored server setting.
        // Use the origin the installer reports rather than rebuilding it from
        // the hostname: rebuilding drops the port, and the app then knocks on
        // 443, meets whatever else lives there, and refuses its certificate
        // as "changed" -- which is correct behaviour reporting the wrong
        // problem.
        val url = res.optString("origin").ifEmpty {
            val host = res.optString("hostname")
            val u = res.optString("url")
            // Older installers reported no origin; recover it from the URL.
            if (u.startsWith("https://")) u.substringBefore("/group/")
            else "https://$host"
        }
        setResult(RESULT_OK, Intent().putExtra(MainActivity.EXTRA_DEPLOYED_URL, url))
        finish()
    }

    override fun onDestroy() {
        worker?.interrupt()
        super.onDestroy()
    }
}
