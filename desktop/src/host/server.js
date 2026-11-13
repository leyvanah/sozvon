'use strict';

// Runs the Sozvon server on this computer, as a child of the app.
//
// The arguments are the ones contrib/install.sh gives a server behind a
// router (see "Behind NAT" there): HTTPS with a Let's Encrypt certificate for
// the sslip.io name of the public address, that address advertised with
// -public-ip, and all media on the one UDP port -udp-range names, so a single
// forward carries it.
//
// Two facts shape the process handling, both measured on a Windows 11
// machine rather than read about:
//
//   - Whether the server outlives the app depends on the system.  On
//     Windows, libuv puts every child spawned without `detached` in a job
//     object that kills it when the parent exits, so a crashed app takes the
//     server with it (killing the parent alone: the attached server died,
//     a detached one survived).  On Linux and macOS a child is orphaned and
//     goes on holding 8443 and 1194, and the next start fails with "address
//     in use".  So the PID is kept in a file and a leftover server is ended
//     before a new one starts -- which also covers a detached server.
//   - -udp-range binds the media port on each interface address that exists
//     when the server starts (pion's NewMultiUDPMuxFromPort), not on
//     0.0.0.0.  A new LAN address -- DHCP, another network -- has no media
//     socket until the server is started again, so the owner of this object
//     calls restart() when the addresses change.
//
// Windows has no SIGTERM: kill() is TerminateProcess, so the server gets no
// chance to close connections.  Nothing on disk depends on a clean exit apart
// from a recording in progress, which is cut short.
//
// SOZVON is a fork of Galène (MIT); see LICENCE.

const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

/** The sslip.io name for an IPv4 address: 203.0.113.7 -> 203-0-113-7.sslip.io */
function sslipName(ip) {
  return `${ip.split('.').join('-')}.sslip.io`;
}

/**
 * The server's command line.
 *
 * @param {Object} o
 * @param {string} o.dir - where data/, groups/ and recordings/ live
 * @param {string} o.staticDir
 * @param {string} [o.publicIP] - behind a router: the router's public address
 * @param {number} [o.httpsPort=8443]
 * @param {number} [o.udpPort=8443]
 * @param {boolean} [o.letsencrypt=true] - certificate for sslipName(publicIP)
 * @param {boolean} [o.turnTls=true] - the relay over TLS on 5349 as well
 * @param {string[]} [o.extra] - appended as they are (tests, -insecure)
 */
function serverArgs(o) {
  const httpsPort = o.httpsPort || 8443;
  const args = [
    '-http', `:${httpsPort}`,
    '-static', o.staticDir,
    '-data', path.join(o.dir, 'data') + path.sep,
    '-groups', path.join(o.dir, 'groups') + path.sep,
    '-recordings', path.join(o.dir, 'recordings') + path.sep,
    '-udp-range', String(o.udpPort || 8443),
  ];
  if (o.publicIP) {
    if (o.letsencrypt !== false) {
      const name = sslipName(o.publicIP);
      args.push('-letsencrypt', name);
      if (o.turnTls !== false) args.push('-turn-tls', `${name}:5349`);
    }
    args.push('-public-ip', o.publicIP);
  }
  return args.concat(o.extra || []);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it is just not ours to signal.
    return e.code === 'EPERM';
  }
}

class ServerProcess extends EventEmitter {
  /**
   * @param {Object} o
   * @param {string} o.binary - the sozvon executable
   * @param {string[]} o.args
   * @param {string} o.dir - its working directory; the PID file goes here
   * @param {number} [o.maxLines=500] - how much of its log to keep
   * @param {number[]} [o.backoff] - restart delays after a crash, ms
   */
  constructor(o) {
    super();
    this.binary = o.binary;
    this.args = o.args;
    this.dir = o.dir;
    this.maxLines = o.maxLines || 500;
    this.backoff = o.backoff || [1000, 5000, 15000, 60000];
    this.pidFile = path.join(o.dir, 'sozvon.pid');
    this.lines = [];
    this.child = null;
    this.wanted = false;
    this.crashes = 0;
    this.timer = null;
  }

  /** Ends a server a previous run of the app left behind. */
  reapLeftover() {
    let pid;
    try {
      pid = Number(fs.readFileSync(this.pidFile, 'utf8').trim());
    } catch (_) {
      return false;
    }
    try { fs.unlinkSync(this.pidFile); } catch (_) { /* gone */ }
    if (!pid || !alive(pid)) return false;
    // A PID is reused once its process is gone; only end it if it is still
    // our binary.  Node cannot ask a process its image name portably, so on
    // Windows ask tasklist and accept a match on the file name.
    if (process.platform === 'win32') {
      const { execFileSync } = require('child_process');
      let out = '';
      try {
        out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
          { encoding: 'utf8', windowsHide: true });
      } catch (_) { /* tasklist missing: do not kill blindly */ }
      if (!out.toLowerCase().includes(path.basename(this.binary).toLowerCase())) return false;
    }
    try { process.kill(pid); } catch (_) { return false; }
    this._log(`ended a server left running by a previous start (pid ${pid})`);
    return true;
  }

  start() {
    this.wanted = true;
    if (this.child) return;
    this.reapLeftover();
    fs.mkdirSync(this.dir, { recursive: true });
    for (const d of ['data', 'groups', 'recordings']) {
      fs.mkdirSync(path.join(this.dir, d), { recursive: true });
    }
    const child = spawn(this.binary, this.args, {
      cwd: this.dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.startedAt = Date.now();
    if (child.pid) fs.writeFileSync(this.pidFile, String(child.pid));
    const onData = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line) this._log(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      this._log(`cannot start ${this.binary}: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      try { fs.unlinkSync(this.pidFile); } catch (_) { /* gone */ }
      this.emit('exit', { code, signal });
      if (!this.wanted) return;
      // A server that ran for a while and then died starts the backoff
      // afresh; one that dies at once keeps climbing it.
      if (Date.now() - this.startedAt > 120000) this.crashes = 0;
      const delay = this.backoff[Math.min(this.crashes, this.backoff.length - 1)];
      this.crashes++;
      this._log(`server exited (${signal || code}); starting again in ${delay / 1000} s`);
      this.timer = setTimeout(() => { this.timer = null; if (this.wanted) this.start(); }, delay);
    });
    this.emit('start', { pid: child.pid });
  }

  /** @returns {Promise<void>} once the process has exited */
  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    });
  }

  async restart(args) {
    if (args) this.args = args;
    await this.stop();
    this.crashes = 0;
    this.start();
  }

  _log(line) {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) this.lines.shift();
    this.emit('line', line);
  }
}

module.exports = { ServerProcess, serverArgs, sslipName };
