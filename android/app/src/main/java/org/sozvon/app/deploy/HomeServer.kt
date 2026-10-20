package org.sozvon.app.deploy

import org.json.JSONArray
import org.json.JSONObject

/**
 * A home server behind a router.  (Sozvon)
 *
 * contrib/install.sh notices when the server's own address is a private one,
 * tells Sozvon the router's public address, and lists the ports the router has
 * to forward -- which it cannot set up itself.  It writes the list to
 * result.json, and to state.json too, so a run that stopped for want of the
 * forwards (code port-forward) can still show it.  Each entry is one line:
 *
 *     "443/tcp -> 192.168.0.60:8444"
 *
 * The desktop app reads the same lines in desktop/src/renderer/home-server.js,
 * and the onboarding in onboarding/flow.js (forwardsOf); the tests there pin
 * the format.
 */
object HomeServer {

    /** One rule for the router: its port and protocol, and where it goes. */
    data class Forward(val port: Int, val proto: String, val toHost: String, val toPort: Int)

    private val FORWARD = Regex("""^\s*(\d+)/(tcp|udp)\s*->\s*([^\s:]+):(\d+)\s*$""")
    private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")

    /**
     * Whether an address is one the internet cannot reach: the ranges
     * install.sh's is_private() treats as "behind a router".  Only a literal
     * IPv4 address counts; a name says nothing until it is resolved, and the
     * installer finds out for itself either way.
     */
    fun isPrivateIPv4(host: String): Boolean {
        val m = IPV4.matchEntire(host.trim()) ?: return false
        val n = m.groupValues.drop(1).map { it.toInt() }
        if (n.any { it > 255 }) return false
        val (a, b) = n
        return a == 10 || a == 127 ||
            (a == 192 && b == 168) ||
            (a == 172 && b in 16..31)
    }

    /** null for a line not in the installer's format: left out, not half shown. */
    fun parseForward(line: String): Forward? {
        val m = FORWARD.matchEntire(line) ?: return null
        val (port, proto, host, to) = m.destructured
        return Forward(port.toInt(), proto, host, to.toInt())
    }

    fun parseForwards(list: JSONArray?): List<Forward> {
        if (list == null) return emptyList()
        return (0 until list.length()).mapNotNull { parseForward(list.optString(it)) }
    }

    /** The raw lines, as the installer wrote them, for an exception to carry. */
    fun lines(list: JSONArray?): List<String> {
        if (list == null) return emptyList()
        return (0 until list.length()).map { list.optString(it) }
    }

    /**
     * Whether the installer put this server behind a router.  An installer
     * from before home servers reports nothing about it, which reads as "no",
     * what it assumed.
     */
    fun behindNat(result: JSONObject): Boolean =
        result.optBoolean("behind_nat", false)
}
