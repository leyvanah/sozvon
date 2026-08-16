package org.sozvon.app.deploy

import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import com.jcraft.jsch.UserInfo
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import android.util.Base64

/**
 * Drives contrib/install.sh on a remote server over SSH.
 *
 * This class does not know how to install Sozvon.  The installer script does --
 * it is the same script a person runs by hand, and it is what was tested.
 * All this does is put the script there, start it detached, and report what
 * its state file says.
 *
 * Everything here blocks; call it from a background thread.
 */
class SshDeployer(
    private val host: String,
    private val port: Int,
    private val username: String,
    private val password: String?,
    private val privateKey: ByteArray? = null,
    private val passphrase: String? = null,
    /** The installer's contents, read from the app's assets. */
    private val installerScript: String,
    /** Previously accepted fingerprint for this host, or null if never seen. */
    private val knownFingerprint: String? = null,
) {
    companion object {
        const val REMOTE_SCRIPT = "/tmp/sozvon-install.sh"
        const val STATE_FILE = "/var/lib/sozvon-install/state.json"
        const val RESULT_FILE = "/var/lib/sozvon-install/result.json"

        /** The nine stages install.sh reports, in order. */
        val STAGES = listOf(
            "preflight", "user", "fetch", "tls",
            "config", "firewall", "service", "verify", "done",
        )

        fun fingerprintOf(key: ByteArray): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(key)
            val b64 = Base64.encodeToString(digest, Base64.NO_WRAP or Base64.NO_PADDING)
            return "SHA256:$b64"
        }

        /**
         * POSIX single-quote escaping: everything inside '...' is literal, and
         * a literal ' is written by closing, escaping and reopening.
         */
        fun shellQuote(s: String): String = "'" + s.replace("'", "'\\''") + "'"
    }

    /** What the caller is told while work is going on. */
    sealed class Progress {
        data class Phase(val phase: String) : Progress()
        data class Stage(val stage: String, val index: Int, val total: Int,
                         val message: String?) : Progress()
    }

    class DeployException(
        message: String,
        val code: String = "error",
        val detail: String? = null,
    ) : Exception(message)

    /** How the caller answers the host-key question. */
    interface HostKeyPrompt {
        /**
         * Called on the worker thread; block until the user decides.
         * @param changed true when a different key was accepted before.
         */
        fun confirm(fingerprint: String, changed: Boolean, previous: String?): Boolean
    }

    private var session: Session? = null
    var seenFingerprint: String? = null
        private set

    private class Result(val code: Int, val stdout: String, val stderr: String)

    // ------------------------------------------------------------ connect --

    fun connect(prompt: HostKeyPrompt) {
        val jsch = JSch()
        if (privateKey != null) {
            jsch.addIdentity("sozvon", privateKey, null, passphrase?.toByteArray())
        }

        // Never accept a host key silently: whoever sits in the middle of this
        // connection is being handed root on the user's server.
        jsch.hostKeyRepository = object : HostKeyRepository {
            override fun check(host: String?, key: ByteArray?): Int {
                if (key == null) return HostKeyRepository.NOT_INCLUDED
                val fp = fingerprintOf(key)
                seenFingerprint = fp
                if (knownFingerprint != null && knownFingerprint == fp) {
                    return HostKeyRepository.OK
                }
                val accepted = prompt.confirm(
                    fp,
                    knownFingerprint != null,
                    knownFingerprint,
                )
                return if (accepted) HostKeyRepository.OK
                else HostKeyRepository.NOT_INCLUDED
            }

            override fun add(hostkey: HostKey?, ui: UserInfo?) = Unit
            override fun remove(host: String?, type: String?) = Unit
            override fun remove(host: String?, type: String?, key: ByteArray?) = Unit
            override fun getKnownHostsRepositoryID(): String = "sozvon"
            override fun getHostKey(): Array<HostKey> = emptyArray()
            override fun getHostKey(host: String?, type: String?): Array<HostKey> =
                emptyArray()
        }

        val s = jsch.getSession(username, host, port)
        if (password != null) s.setPassword(password)
        s.setConfig("PreferredAuthentications", "publickey,password,keyboard-interactive")
        try {
            s.connect(20_000)
        } catch (e: Exception) {
            val m = e.message ?: ""
            val friendly = when {
                m.contains("Auth fail", true) ||
                    m.contains("Auth cancel", true) ->
                    "The server refused these credentials."
                m.contains("reject HostKey", true) ||
                    m.contains("HostKey", true) ->
                    "The server's key was not accepted."
                m.contains("UnknownHost", true) ||
                    m.contains("Unable to resolve", true) ->
                    "Cannot resolve the name $host."
                m.contains("Connection refused", true) ->
                    "Nothing is listening on $host:$port."
                m.contains("timeout", true) ->
                    "$host:$port did not respond."
                else -> m.ifEmpty { "Could not connect." }
            }
            throw DeployException(friendly, "connect", m)
        }
        session = s
    }

    fun disconnect() {
        try {
            session?.disconnect()
        } catch (_: Exception) {
            // already gone
        }
        session = null
    }

    // ------------------------------------------------------------- exec ----

    private fun exec(command: String, stdin: String? = null): Result {
        val s = session ?: throw DeployException("not connected", "state")
        val channel = s.openChannel("exec") as ChannelExec
        channel.setCommand(command)
        val out = ByteArrayOutputStream()
        val err = ByteArrayOutputStream()
        // JSch's naming is a trap worth spelling out: setOutputStream() says
        // where the remote command's *stdout* should go, while
        // getOutputStream() hands back the stream we write the command's
        // *stdin* to.  Same name, opposite directions -- so both are called
        // explicitly here rather than through Kotlin's synthesised
        // `outputStream` property, which would make them look like one thing.
        channel.setOutputStream(out)
        channel.setErrStream(err)
        val stdinStream = channel.getOutputStream()
        channel.connect(15_000)
        if (stdin != null) {
            stdinStream.write(stdin.toByteArray())
            stdinStream.flush()
        }
        stdinStream.close()
        // JSch has no blocking wait; poll until the remote side closes.
        while (!channel.isClosed) {
            Thread.sleep(80)
        }
        val code = channel.exitStatus
        channel.disconnect()
        return Result(code, out.toString("UTF-8"), err.toString("UTF-8"))
    }

    /**
     * Wrap a command so it runs as root.  Already root: unchanged.  Otherwise
     * sudo reads the password from stdin, keeping it out of the process table.
     */
    private fun privileged(command: String, extraStdin: String = ""): Pair<String, String?> {
        if (username == "root") {
            return Pair(command, if (extraStdin.isEmpty()) null else extraStdin)
        }
        val wrapped = "sudo -S -p '' sh -c " + shellQuote(command)
        val stdin = (if (password != null) "$password\n" else "") + extraStdin
        return Pair(wrapped, stdin)
    }

    private fun runPrivileged(command: String): Result {
        val (cmd, stdin) = privileged(command)
        return exec(cmd, stdin)
    }

    // ------------------------------------------------------------ stages ---

    private fun checkPrivileges() {
        val r = runPrivileged("id -u")
        val uid = r.stdout.trim().split(Regex("\\s+")).lastOrNull()
        if (uid != "0") {
            throw DeployException(
                if (username == "root")
                    "Logged in as root but the server does not agree."
                else
                    "$username cannot become root on this server. Use the root " +
                        "account, or give this user sudo access.",
                "privileges",
                r.stderr.ifEmpty { r.stdout },
            )
        }
    }

    private fun uploadScript() {
        // Sent through stdin rather than SFTP: some hardened servers disable
        // the SFTP subsystem, and this needs nothing beyond a shell.  The
        // heredoc is quoted, so the remote shell expands nothing inside.
        val body = installerScript.replace("\r\n", "\n")
        val cmd = "cat > $REMOTE_SCRIPT <<'SOZVON_INSTALLER_EOF'\n" +
            body + "\nSOZVON_INSTALLER_EOF\nchmod 700 $REMOTE_SCRIPT"
        val r = runPrivileged(cmd)
        if (r.code != 0) {
            throw DeployException("Could not upload the installer.", "upload", r.stderr)
        }
        // Confirm it arrived intact rather than trusting the write.
        val c = runPrivileged("sh -n $REMOTE_SCRIPT && echo SYNTAX_OK")
        if (!c.stdout.contains("SYNTAX_OK")) {
            throw DeployException(
                "The installer did not survive the upload intact.", "upload", c.stderr)
        }
    }

    private fun buildArgs(o: Options): String {
        val args = mutableListOf("--detach", "--tls", o.tlsMode)
        o.domain?.takeIf { it.isNotBlank() }?.let { args += listOf("--domain", it) }
        o.ip?.takeIf { it.isNotBlank() }?.let { args += listOf("--ip", it) }
        o.version?.takeIf { it.isNotBlank() }?.let { args += listOf("--version", it) }
        o.mirror?.takeIf { it.isNotBlank() }?.let { args += listOf("--mirror", it) }
        o.group?.takeIf { it.isNotBlank() }?.let { args += listOf("--group", it) }
        o.adminUser?.takeIf { it.isNotBlank() }?.let { args += listOf("--admin-user", it) }
        if (!o.adminPassword.isNullOrBlank()) args += "--admin-password-env"
        // A host whose 443 is taken can still run Sozvon elsewhere; Let's
        // Encrypt cannot, and the installer refuses that combination itself.
        o.httpsPort?.let { args += listOf("--port", it.toString()) }
        return args.joinToString(" ") { shellQuote(it) }
    }

    private fun start(o: Options) {
        // The operator password goes in the environment, never the command
        // line: /proc/<pid>/cmdline is world-readable.
        val env = if (!o.adminPassword.isNullOrBlank())
            "SOZVON_ADMIN_PASSWORD=" + shellQuote(o.adminPassword) + " " else ""
        val r = runPrivileged("${env}sh $REMOTE_SCRIPT ${buildArgs(o)}")
        if (r.code != 0) {
            throw DeployException(
                "The installer refused to start.", "start",
                (r.stderr + r.stdout).trim())
        }
    }

    private fun readState(): JSONObject? {
        val r = runPrivileged("cat $STATE_FILE 2>/dev/null || true")
        val text = r.stdout.trim()
        if (text.isEmpty()) return null
        return try {
            JSONObject(text)
        } catch (_: Exception) {
            // The script renames the file into place, so a torn read should be
            // impossible -- but it is not worth failing over.  Try again.
            null
        }
    }

    private fun tail(lines: Int = 40): String = try {
        runPrivileged("tail -n $lines /var/log/sozvon-install.log 2>/dev/null || true").stdout
    } catch (_: Exception) {
        ""
    }

    /**
     * Read the installer's result -- and then delete it.
     *
     * The file carries the generated operator password in clear (mode 0600,
     * root), because it is how the installer hands the result back to whoever
     * drove it.  install.sh's own closing message tells the reader to delete
     * it once they have it, and nothing ever did: the password the result
     * screen calls "shown only once" was in fact sitting on the server for
     * good, for anyone who later gained root -- or the docker group, which
     * amounts to the same thing.
     *
     * We are that reader, so we do it here, and only after the text has parsed
     * -- a delete before the JSON is known-good would destroy the password on
     * a file we could not read.  Failure to remove it is not worth failing the
     * install over: the server is up and the user has their password.
     */
    private fun readResult(): JSONObject {
        val r = runPrivileged("cat $RESULT_FILE 2>/dev/null || true")
        val text = r.stdout.trim()
        if (text.isEmpty()) {
            throw DeployException(
                "The install finished but left no result file.", "result")
        }
        val json = JSONObject(text)
        try {
            runPrivileged("rm -f $RESULT_FILE")
        } catch (_: Exception) {
        }
        return json
    }

    /**
     * Poll the state file until the installer finishes.
     *
     * Polling, rather than holding the installer's output open, is the whole
     * reason install.sh detaches: a phone will sleep or change network during
     * a multi-minute install, and the work must survive that.
     */
    private fun waitForCompletion(
        prompt: HostKeyPrompt,
        onProgress: (Progress) -> Unit,
        timeoutMs: Long = 20 * 60 * 1000L,
    ): JSONObject {
        val started = System.currentTimeMillis()
        var lastStage: String? = null
        var errors = 0

        while (true) {
            if (System.currentTimeMillis() - started > timeoutMs) {
                throw DeployException("The install did not finish in time.",
                    "timeout", tail())
            }

            val state = try {
                val st = readState()
                errors = 0
                st
            } catch (e: Exception) {
                // A dropped connection mid-install is expected, not fatal: the
                // work continues on the server.  Reconnect and keep reading.
                errors++
                if (errors > 5) {
                    throw DeployException(
                        "Lost contact with the server during the install.",
                        "connection", e.message)
                }
                disconnect()
                try {
                    connect(prompt)
                } catch (_: Exception) {
                    // retried on the next pass
                }
                Thread.sleep(2000)
                continue
            }

            if (state != null) {
                val stage = state.optString("stage")
                if (stage != lastStage) {
                    lastStage = stage
                    onProgress(Progress.Stage(
                        stage,
                        state.optInt("stage_index"),
                        state.optInt("stage_total", STAGES.size),
                        state.optString("message").ifEmpty { null },
                    ))
                }
                when (state.optString("status")) {
                    "done" -> return readResult()
                    "failed" -> throw DeployException(
                        state.optString("error").ifEmpty {
                            state.optString("message").ifEmpty { "The install failed." }
                        },
                        "install", tail())
                }
            }

            Thread.sleep(2000)
        }
    }

    data class Options(
        val tlsMode: String,
        val domain: String? = null,
        val ip: String? = null,
        val group: String? = "meet",
        val adminUser: String? = "operator",
        val adminPassword: String? = null,
        val version: String? = null,
        val mirror: String? = null,
        /** HTTPS port; null means the installer's default, 443. */
        val httpsPort: Int? = null,
    )

    /** The whole thing: upload, start, wait, return the installer's result. */
    fun deploy(
        rawOptions: Options,
        prompt: HostKeyPrompt,
        onProgress: (Progress) -> Unit,
    ): JSONObject {
        // The address we reached this server at is, by definition, one that
        // works from here.  Left to guess, the installer asks an outside
        // service for "your public IP" and gets whatever the server's traffic
        // exits through -- a VPN endpoint, a NAT gateway -- which is not where
        // the server answers.  Defaulted here rather than in a caller, so no
        // caller can forget it.
        val options = if (rawOptions.ip.isNullOrBlank())
            rawOptions.copy(ip = host) else rawOptions

        onProgress(Progress.Phase("checking"))
        checkPrivileges()
        onProgress(Progress.Phase("uploading"))
        uploadScript()
        onProgress(Progress.Phase("starting"))
        start(options)
        onProgress(Progress.Phase("installing"))
        return waitForCompletion(prompt, onProgress)
    }

    /**
     * Remove Sozvon from the server: `--uninstall` stops and removes the service
     * and leaves `data/` and `groups/` -- rooms, accounts, invite links and
     * certificates -- where they are, so installing again picks them back up.
     * `--purge` deletes those too.
     *
     * Unlike an install this runs to completion over the open connection
     * rather than detached: it takes seconds, has nothing to download and no
     * stage worth polling, so there is nothing for a dropped connection to
     * outlive.
     *
     * @return what the script reported, for the screen that says what happened
     */
    fun uninstall(purge: Boolean, onProgress: (Progress) -> Unit): String {
        onProgress(Progress.Phase("checking"))
        checkPrivileges()
        onProgress(Progress.Phase("uploading"))
        uploadScript()
        onProgress(Progress.Phase("removing"))
        val flag = if (purge) "--purge" else "--uninstall"
        val r = runPrivileged("sh $REMOTE_SCRIPT $flag")
        if (r.code != 0) {
            throw DeployException(
                "Could not remove the server.", "uninstall",
                (r.stderr + r.stdout).trim())
        }
        return (r.stdout + r.stderr).trim()
    }
}
