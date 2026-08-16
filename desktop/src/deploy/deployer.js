'use strict';

// Drives contrib/install.sh on a remote server over SSH.
//
// Deliberately plain Node with no Electron imports, so it can be exercised
// against a real server from the command line (see scripts/test-deploy.js)
// rather than only by clicking through the app.
//
// The division of labour matters: this file does not know how to install
// Sozvon.  The installer script does, it is the same script a person would run
// by hand, and it is the thing that was tested.  All this does is put the
// script there, start it detached, and report what its state file says.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');

const REMOTE_SCRIPT = '/tmp/sozvon-install.sh';
const STATE_FILE = '/var/lib/sozvon-install/state.json';
const RESULT_FILE = '/var/lib/sozvon-install/result.json';

// install.sh reports nine stages; keep the labels here so the UI can show
// something meaningful before the first state file even appears.
const STAGES = [
  'preflight', 'user', 'fetch', 'tls',
  'config', 'firewall', 'service', 'verify', 'done',
];

function fingerprintOf(keyBlob) {
  const hash = crypto.createHash('sha256').update(keyBlob).digest('base64');
  // OpenSSH prints SHA256 fingerprints base64 without padding.
  return 'SHA256:' + hash.replace(/=+$/, '');
}

/**
 * Where to find the installer.
 *
 * In a packaged app it has been copied into resources/ by
 * scripts/sync-installer.js.  Running straight from a checkout, that copy may
 * not exist yet, so fall back to the repository's own contrib/install.sh --
 * which is the source of the copy anyway.  This keeps `node
 * scripts/test-deploy.js` working with no build step.
 */
function defaultScriptPath() {
  const packaged = path.join(__dirname, '..', '..', 'resources', 'install.sh');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', '..', 'contrib', 'install.sh');
}

function shellQuote(s) {
  // POSIX single-quote escaping: everything is literal inside '...', and a
  // literal ' is written by closing, escaping, and reopening the quotes.
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

class DeployError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'DeployError';
    this.code = opts.code || 'error';
    this.detail = opts.detail;
  }
}

class Deployer {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port]
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {string} [opts.privateKey]      PEM contents
   * @param {string} [opts.passphrase]      for an encrypted private key
   * @param {function} [opts.verifyHostKey] async ({fingerprint, keyType}) => bool
   * @param {function} [opts.onEvent]       ({type, ...}) => void
   * @param {string}  [opts.scriptPath]     installer to upload
   */
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port || 22;
    this.username = opts.username || 'root';
    this.password = opts.password;
    this.privateKey = opts.privateKey;
    this.passphrase = opts.passphrase;
    this.verifyHostKey = opts.verifyHostKey || (async () => false);
    this.onEvent = opts.onEvent || (() => {});
    this.scriptPath = opts.scriptPath || defaultScriptPath();
    this.conn = null;
    this.hostKey = null;
  }

  emit(event) {
    try {
      this.onEvent(event);
    } catch {
      /* a listener must never break the deployment */
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) {
          try { conn.end(); } catch { /* already gone */ }
          reject(err);
        } else {
          resolve();
        }
      };

      conn.on('ready', () => { this.conn = conn; done(null); });

      conn.on('error', (err) => {
        // ssh2's messages are terse; say what the user can act on.
        let msg = err.message || String(err);
        if (/All configured authentication methods failed/i.test(msg)) {
          msg = 'The server refused these credentials.';
        } else if (/ECONNREFUSED/.test(msg)) {
          msg = `Nothing is listening on ${this.host}:${this.port}.`;
        } else if (/ETIMEDOUT|timed out/i.test(msg)) {
          msg = `${this.host}:${this.port} did not respond.`;
        } else if (/ENOTFOUND|EAI_AGAIN/.test(msg)) {
          msg = `Cannot resolve the name ${this.host}.`;
        }
        done(new DeployError(msg, { code: 'connect', detail: err.message }));
      });

      conn.connect({
        host: this.host,
        port: this.port,
        username: this.username,
        password: this.password,
        privateKey: this.privateKey,
        passphrase: this.passphrase,
        readyTimeout: 20000,
        // Never accept a host key silently: a machine-in-the-middle here
        // would be handed root on the server.  The caller decides, and is
        // shown the fingerprint to decide with.
        hostVerifier: (keyBlob, cb) => {
          const info = {
            fingerprint: fingerprintOf(keyBlob),
            host: this.host,
            port: this.port,
          };
          this.hostKey = info;
          Promise.resolve(this.verifyHostKey(info))
            .then((ok) => cb(!!ok))
            .catch(() => cb(false));
        },
      });
    });
  }

  disconnect() {
    if (this.conn) {
      try { this.conn.end(); } catch { /* already gone */ }
      this.conn = null;
    }
  }

  /** Run a command, resolving with {code, stdout, stderr}. */
  exec(command, { stdin } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.conn) {
        reject(new DeployError('not connected', { code: 'state' }));
        return;
      }
      this.conn.exec(command, (err, stream) => {
        if (err) {
          reject(new DeployError(err.message, { code: 'exec' }));
          return;
        }
        let stdout = '';
        let stderr = '';
        let code = null;
        stream.on('close', (c) => resolve({ code: c === null ? code : c, stdout, stderr }));
        stream.on('exit', (c) => { code = c; });
        stream.on('data', (d) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        if (stdin !== undefined) {
          stream.write(stdin);
          stream.end();
        }
      });
    });
  }

  /**
   * Wrap a command so it runs with root privileges.  Already root: unchanged.
   * Otherwise sudo reads the password from stdin, which keeps it out of the
   * process table.
   */
  privileged(command, stdinExtra = '') {
    if (this.username === 'root') {
      return { command, stdin: stdinExtra === '' ? undefined : stdinExtra };
    }
    return {
      command: `sudo -S -p '' sh -c ${shellQuote(command)}`,
      stdin: (this.password ? this.password + '\n' : '') + stdinExtra,
    };
  }

  async checkPrivileges() {
    const { command, stdin } = this.privileged('id -u');
    const r = await this.exec(command, { stdin });
    const uid = (r.stdout || '').trim().split(/\s+/).pop();
    if (uid !== '0') {
      throw new DeployError(
        this.username === 'root'
          ? 'Logged in as root but the server does not agree; cannot continue.'
          : `${this.username} cannot become root on this server. ` +
            'Use the root account, or give this user sudo access.',
        { code: 'privileges', detail: r.stderr || r.stdout });
    }
  }

  async uploadScript() {
    const script = fs.readFileSync(this.scriptPath, 'utf8');
    // Send through stdin rather than SFTP: some hardened servers disable the
    // SFTP subsystem, and this needs nothing beyond a shell.  The heredoc is
    // quoted, so the remote shell expands nothing in the script.
    const cmd = `cat > ${REMOTE_SCRIPT} <<'SOZVON_INSTALLER_EOF'\n` +
      script.replace(/\r\n/g, '\n') +
      `\nSOZVON_INSTALLER_EOF\nchmod 700 ${REMOTE_SCRIPT}`;
    const { command, stdin } = this.privileged(cmd);
    const r = await this.exec(command, { stdin });
    if (r.code !== 0) {
      throw new DeployError('Could not upload the installer.',
        { code: 'upload', detail: r.stderr });
    }
    // Confirm it arrived intact rather than trusting the write.
    const check = this.privileged(`sh -n ${REMOTE_SCRIPT} && echo SYNTAX_OK`);
    const c = await this.exec(check.command, { stdin: check.stdin });
    if (!/SYNTAX_OK/.test(c.stdout)) {
      throw new DeployError('The installer did not survive the upload intact.',
        { code: 'upload', detail: c.stderr });
    }
  }

  buildArgs(o) {
    const args = ['--detach', '--tls', o.tlsMode];
    if (o.domain) args.push('--domain', o.domain);
    if (o.ip) args.push('--ip', o.ip);
    if (o.version) args.push('--version', o.version);
    if (o.mirror) args.push('--mirror', o.mirror);
    if (o.group) args.push('--group', o.group);
    if (o.adminUser) args.push('--admin-user', o.adminUser);
    if (o.adminPassword) args.push('--admin-password-env');
    // A host whose 443 is already taken (a reverse proxy, another service)
    // can still run Sozvon elsewhere; Let's Encrypt cannot, and the installer
    // refuses that combination itself.
    if (o.port) args.push('--port', String(o.port));
    if (o.udpPort) args.push('--udp-port', String(o.udpPort));
    return args.map(shellQuote).join(' ');
  }

  async start(options) {
    const args = this.buildArgs(options);
    // The operator password goes in the environment, never the command line:
    // /proc/<pid>/cmdline is world-readable.
    const env = options.adminPassword
      ? `SOZVON_ADMIN_PASSWORD=${shellQuote(options.adminPassword)} `
      : '';
    const cmd = `${env}sh ${REMOTE_SCRIPT} ${args}`;
    const { command, stdin } = this.privileged(cmd);
    const r = await this.exec(command, { stdin });
    if (r.code !== 0) {
      throw new DeployError('The installer refused to start.',
        { code: 'start', detail: (r.stderr || r.stdout || '').trim() });
    }
  }

  async readState() {
    const { command, stdin } = this.privileged(`cat ${STATE_FILE} 2>/dev/null || true`);
    const r = await this.exec(command, { stdin });
    const text = (r.stdout || '').trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // A half-written file should be impossible (the script renames into
      // place), but a partial read is not worth crashing over: try again.
      return null;
    }
  }

  /**
   * Read the installer's result -- and then delete it.
   *
   * The file carries the generated operator password in clear (mode 0600,
   * root), because it is how the installer hands the result back to whoever
   * drove it.  install.sh's own closing message tells the reader to delete it
   * once they have it, and nothing ever did: the password the result screen
   * calls "shown only once" was in fact sitting on the server for good, for
   * anyone who later gained root.
   *
   * We are that reader, so we do it here, and only after the text has parsed
   * -- deleting before the JSON is known-good would destroy the password on a
   * file we could not read.  Failing to remove it is not worth failing the
   * install over: the server is up and the user has their password.
   */
  async readResult() {
    const { command, stdin } = this.privileged(`cat ${RESULT_FILE} 2>/dev/null || true`);
    const r = await this.exec(command, { stdin });
    const text = (r.stdout || '').trim();
    if (!text) {
      throw new DeployError('The install finished but left no result file.',
        { code: 'result' });
    }
    const parsed = JSON.parse(text);
    try {
      const rm = this.privileged(`rm -f ${RESULT_FILE}`);
      await this.exec(rm.command, { stdin: rm.stdin });
    } catch (e) {
      // Best effort; the install itself succeeded.
    }
    return parsed;
  }

  async tail(lines = 40) {
    const { command, stdin } =
      this.privileged(`tail -n ${lines} /var/log/sozvon-install.log 2>/dev/null || true`);
    const r = await this.exec(command, { stdin });
    return r.stdout || '';
  }

  /**
   * Poll the state file until the installer finishes.
   *
   * Polling, rather than holding the installer's own output open, is the
   * whole reason install.sh detaches: this can survive the connection
   * dropping, which on a laptop lid or a phone changing network it will.
   */
  async waitForCompletion({ timeoutMs = 20 * 60 * 1000, intervalMs = 2000 } = {}) {
    const started = Date.now();
    let lastStage = null;
    let consecutiveErrors = 0;

    for (;;) {
      if (Date.now() - started > timeoutMs) {
        throw new DeployError('The install did not finish in time.',
          { code: 'timeout', detail: await this.tail().catch(() => '') });
      }

      let state;
      try {
        state = await this.readState();
        consecutiveErrors = 0;
      } catch (e) {
        // A dropped connection mid-install is expected, not fatal: the work
        // continues on the server.  Reconnect and carry on reading.
        consecutiveErrors++;
        if (consecutiveErrors > 5) {
          throw new DeployError('Lost contact with the server during the install.',
            { code: 'connection', detail: e.message });
        }
        this.disconnect();
        try {
          await this.connect();
        } catch { /* retried on the next pass */ }
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }

      if (state) {
        if (state.stage !== lastStage) {
          lastStage = state.stage;
          this.emit({
            type: 'stage',
            stage: state.stage,
            index: state.stage_index,
            total: state.stage_total,
            message: state.message,
          });
        }
        if (state.status === 'done') {
          return await this.readResult();
        }
        if (state.status === 'failed') {
          throw new DeployError(
            state.error || state.message || 'The install failed.',
            { code: 'install', detail: await this.tail().catch(() => '') });
        }
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** The whole thing: upload, start, wait, return the result. */
  async deploy(options) {
    // The address we reached this server at is, by definition, one that works
    // from here.  Left to guess, the installer asks an outside service for
    // "your public IP" and gets whatever the server's traffic exits through
    // -- a VPN endpoint, a NAT gateway -- which is not where the server
    // answers.  Defaulted here rather than in a caller so no caller can
    // forget it.
    options = { ...options, ip: options.ip || this.host };

    this.emit({ type: 'phase', phase: 'checking' });
    await this.checkPrivileges();

    this.emit({ type: 'phase', phase: 'uploading' });
    await this.uploadScript();

    this.emit({ type: 'phase', phase: 'starting' });
    await this.start(options);

    this.emit({ type: 'phase', phase: 'installing' });
    return await this.waitForCompletion();
  }
}

/**
 * The scheme://host[:port] a client should use, taken from what the installer
 * reported rather than rebuilt from the hostname -- rebuilding drops the port,
 * and the client then knocks on 443, meets whatever else lives there, and
 * rejects its certificate as "changed": correct behaviour reporting the wrong
 * problem.
 */
function originOf(result) {
  if (!result) return '';
  if (result.origin) return result.origin;
  // Older installers reported no origin; recover it from the URL.
  const url = String(result.url || '');
  if (url.startsWith('https://')) return url.split('/group/')[0];
  return result.hostname ? `https://${result.hostname}` : '';
}

module.exports = {
  Deployer, DeployError, STAGES, fingerprintOf, shellQuote, originOf,
};
