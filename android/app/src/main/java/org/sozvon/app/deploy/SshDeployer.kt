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
    /**
     * The release shipped inside the APK, or null if this build has none.
     * Used to install a server that cannot reach GitHub -- which, on Russian
     * hosting, is the ordinary case rather than the exception.
     */
    private val bundledRelease: BundledRelease? = null,
) {
    companion object {
        const val REMOTE_SCRIPT = "/tmp/sozvon-install.sh"
        const val STATE_FILE = "/var/lib/sozvon-install/state.json"
        const val RESULT_FILE = "/var/lib/sozvon-install/result.json"

        /**
         * Where the bundled release is put on the server.  The installer is
         * then pointed at it with --mirror, which is an ordinary, already
         * tested path through the script: nothing about installing from the
         * APK is a special case on the server side.
         */
        const val REMOTE_MIRROR = "/tmp/sozvon-artifacts"

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
        /**
         * Sending the bundled release, which is several megabytes and the one
         * step slow enough that a still screen would read as a hang.
         */
        data class Transfer(val sent: Long, val total: Long) : Progress()
    }

    /**
     * The server release carried inside the APK: the archive for each
     * architecture, and the checksum file that goes with them.  The archive is
     * opened as a stream rather than handed over as bytes -- it is around 8 MB
     * per architecture, and holding that in memory to send it would be a waste
     * on a phone.
     */
    class BundledRelease(
        /** Release tag the APK carries, e.g. "v0.2.0". */
        val version: String,
        /** Contents of the release's SHA256SUMS, verbatim. */
        val sums: String,
        /** Opens an asset by path, e.g. "server/sozvon_v0.2.0_linux_amd64.tar.gz". */
        private val openAsset: (String) -> java.io.InputStream,
        /** Size of each archive, by architecture, for the progress bar. */
        private val sizes: Map<String, Long>,
    ) {
        fun archiveName(arch: String) = "sozvon_${version}_linux_$arch.tar.gz"
        fun has(arch: String) = sizes.containsKey(arch)
        fun size(arch: String) = sizes[arch] ?: 0L
        fun openArchive(arch: String): java.io.InputStream =
            openAsset("server/" + archiveName(arch))
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

    /**
     * What the server runs on, in the installer's own vocabulary, or null if
     * it is something the release does not cover -- in which case installing
     * from the APK is not possible and the caller falls back to a download.
     */
    private fun detectArch(): String? {
        val r = runPrivileged("uname -m")
        return when (r.stdout.trim().lines().lastOrNull()?.trim()) {
            "x86_64", "amd64" -> "amd64"
            "aarch64", "arm64" -> "arm64"
            else -> null
        }
    }

    /**
     * Send a file the server cannot download for itself.
     *
     * Streamed through `base64 -d` on an exec channel rather than over SFTP,
     * for the same reason the installer is: SFTP is a separate subsystem and
     * hardened servers switch it off, while this needs nothing but a shell.
     * base64 rather than raw bytes because the channel carries a shell's
     * stdin, and a stray byte sequence in a binary is not worth the risk.
     *
     * Deliberately **not** wrapped in sudo.  sudo reads its password from
     * stdin, and stdin here is the file: the two cannot share the stream.  So
     * the destination is a directory under /tmp that the login user owns --
     * see uploadBundledRelease, which creates it -- and no privilege is
     * needed to write there.
     */
    private fun uploadBinary(
        remotePath: String,
        source: java.io.InputStream,
        total: Long,
        onProgress: (Progress) -> Unit,
    ) {
        val s = session ?: throw DeployException("not connected", "state")
        val channel = s.openChannel("exec") as ChannelExec
        channel.setCommand("base64 -d > " + shellQuote(remotePath))
        val out = ByteArrayOutputStream()
        val err = ByteArrayOutputStream()
        channel.setOutputStream(out)
        channel.setErrStream(err)
        val stdin = channel.getOutputStream()
        channel.connect(15_000)
        try {
            // The chunk size must be a multiple of 3.  Base64 encodes three
            // bytes to four characters, so a chunk of any other length is
            // padded with '=' -- and padding in the middle of a stream ends
            // the decode there, silently truncating the file.
            val buf = ByteArray(3 * 16 * 1024)
            var sent = 0L
            source.use { ins ->
                while (true) {
                    // read() may return a short count at any time, not only at
                    // the end, so fill the buffer before encoding it.
                    var n = 0
                    while (n < buf.size) {
                        val r = ins.read(buf, n, buf.size - n)
                        if (r < 0) break
                        n += r
                    }
                    if (n == 0) break
                    stdin.write(Base64.encode(buf, 0, n, Base64.NO_WRAP))
                    stdin.write('\n'.code)
                    sent += n
                    onProgress(Progress.Transfer(sent, total))
                    if (n < buf.size) break
                }
            }
            stdin.flush()
        } finally {
            stdin.close()
        }
        while (!channel.isClosed) {
            Thread.sleep(80)
        }
        val code = channel.exitStatus
        channel.disconnect()
        if (code != 0) {
            throw DeployException(
                "Could not send the server package.", "upload",
                err.toString("UTF-8").trim().ifEmpty { out.toString("UTF-8").trim() })
        }
    }

    /**
     * Put the APK's own copy of the release on the server, arranged exactly
     * like a release mirror: the archive, the checksums, and a `latest` file
     * naming the version.  The installer then treats it as any other mirror
     * and still verifies the checksum itself.
     *
     * @return the --mirror value to install from
     */
    private fun uploadBundledRelease(
        rel: BundledRelease,
        arch: String,
        onProgress: (Progress) -> Unit,
    ): String {
        // Created with sudo because a previous run may have left it owned by
        // root, then handed to the login user: the upload itself cannot use
        // sudo (its stdin carries the file), so it must be able to write here
        // unprivileged.  0700 rather than /tmp's 1777, so no other local user
        // can swap the archive between the upload and the install.
        val r = runPrivileged(
            "rm -rf $REMOTE_MIRROR && mkdir -p $REMOTE_MIRROR && " +
                "chown " + shellQuote(username) + " $REMOTE_MIRROR && " +
                "chmod 700 $REMOTE_MIRROR")
        if (r.code != 0) {
            throw DeployException(
                "Could not prepare $REMOTE_MIRROR on the server.", "upload", r.stderr)
        }
        val name = rel.archiveName(arch)
        uploadBinary("$REMOTE_MIRROR/$name", rel.openArchive(arch), rel.size(arch), onProgress)

        // The two small files go the way the installer does, as quoted
        // heredocs: nothing in them is expanded by the remote shell.  Written
        // as the login user, like the archive, since the directory is theirs.
        val meta = "cat > $REMOTE_MIRROR/SHA256SUMS <<'SOZVON_SUMS_EOF'\n" +
            rel.sums.replace("\r\n", "\n").trimEnd() + "\nSOZVON_SUMS_EOF\n" +
            "printf '%s' " + shellQuote(rel.version) + " > $REMOTE_MIRROR/latest"
        val m = exec(meta)
        if (m.code != 0) {
            throw DeployException(
                "Could not write the mirror's metadata.", "upload", m.stderr)
        }

        // Check here rather than leaving it to the installer: a truncated
        // upload should say so as an upload problem, not surface later as a
        // checksum mismatch that reads like a corrupted release.
        val v = exec(
            "cd $REMOTE_MIRROR && grep " + shellQuote(" $name") +
                " SHA256SUMS > expected.txt && sha256sum -c expected.txt")
        if (v.code != 0) {
            throw DeployException(
                "The server package did not survive the upload intact.", "upload",
                (v.stderr + v.stdout).trim())
        }
        return "file://$REMOTE_MIRROR"
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
        /**
         * Install the release carried in the APK instead of downloading one.
         * On by default: a server that cannot reach GitHub is the ordinary
         * case for this audience, and the failure it produces otherwise is
         * a timeout deep inside the installer's fetch stage.  Turned off to
         * get whatever is current upstream instead.  An explicit --mirror
         * always wins over both.
         */
        val useBundled: Boolean = true,
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
        var options = if (rawOptions.ip.isNullOrBlank())
            rawOptions.copy(ip = host) else rawOptions

        onProgress(Progress.Phase("checking"))
        checkPrivileges()
        onProgress(Progress.Phase("uploading"))
        uploadScript()

        // An explicit mirror is the caller's decision and is left alone; the
        // bundled copy only fills the case where nothing else was chosen.
        val rel = bundledRelease
        if (options.useBundled && rel != null && options.mirror.isNullOrBlank()) {
            val arch = detectArch()
            if (arch != null && rel.has(arch)) {
                onProgress(Progress.Phase("sending"))
                val mirror = uploadBundledRelease(rel, arch, onProgress)
                options = options.copy(mirror = mirror, version = rel.version)
            }
            // An architecture this build does not carry falls through to the
            // installer's own download.  That is the honest outcome: it may
            // well work, and refusing here would block a server the script
            // can perfectly well install by itself.
        }

        onProgress(Progress.Phase("starting"))
        start(options)
        onProgress(Progress.Phase("installing"))
        try {
            return waitForCompletion(prompt, onProgress)
        } finally {
            // Several megabytes under /tmp, of no use once unpacked.  Failure
            // to clean up is not worth reporting over whatever else happened.
            if (options.mirror == "file://$REMOTE_MIRROR") {
                try {
                    runPrivileged("rm -rf $REMOTE_MIRROR")
                } catch (e: Exception) {
                    // ignored on purpose
                }
            }
        }
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
