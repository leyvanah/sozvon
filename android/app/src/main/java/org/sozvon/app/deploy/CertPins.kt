package org.sozvon.app.deploy

import android.content.Context
import android.net.http.SslCertificate
import android.os.Bundle
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/**
 * Certificates the user has decided to trust for a specific host.
 *
 * A server installed with the self-signed TLS mode presents a certificate no
 * public authority vouches for, so a WebView refuses it -- correctly, because
 * the alternative is trusting whatever is on the other end.  The installer
 * reports that certificate's SHA-256, and the user, who has just watched it
 * being generated on their own server over their own SSH session, is in a
 * position to say "that one, and only that one".
 *
 * This deliberately pins the exact certificate rather than accepting anything
 * self-signed: accepting anything would leave the connection open to whoever
 * can answer for the address, which is the thing TLS is there to prevent.
 */
object CertPins {

    private const val PREFS = "sozvon"
    private const val KEY = "pinned_cert"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Host as it appears in the URL, without port. */
    fun get(context: Context, host: String): String? =
        prefs(context).getString("$KEY:${host.lowercase()}", null)

    fun put(context: Context, host: String, sha256Hex: String) {
        prefs(context).edit()
            .putString("$KEY:${host.lowercase()}", normalise(sha256Hex))
            .apply()
    }

    fun clear(context: Context, host: String) {
        prefs(context).edit().remove("$KEY:${host.lowercase()}").apply()
    }

    /** Lower-case hex, no colons or whitespace, so comparisons are literal. */
    fun normalise(fingerprint: String): String =
        fingerprint.replace(":", "").replace(" ", "").trim().lowercase()

    /**
     * SHA-256 over the certificate's DER encoding -- the same thing
     * `openssl x509 -fingerprint -sha256` prints, which is what the
     * installer puts in result.json.
     */
    fun fingerprintOf(cert: X509Certificate): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
        val sb = StringBuilder(digest.size * 2)
        for (b in digest) sb.append("%02x".format(b))
        return sb.toString()
    }

    /**
     * Recover the real certificate from what a WebView SSL error carries.
     *
     * SslCertificate.getX509Certificate() would be the obvious call, but it
     * only exists from API 29 and this app supports 26.  saveState() has
     * carried the DER bytes since long before that.
     */
    fun x509From(certificate: SslCertificate?): X509Certificate? {
        if (certificate == null) return null
        return try {
            val bundle: Bundle = SslCertificate.saveState(certificate)
            val der = bundle.getByteArray("x509-certificate") ?: return null
            val factory = CertificateFactory.getInstance("X.509")
            factory.generateCertificate(der.inputStream()) as? X509Certificate
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Whether this certificate is the one pinned for this host.
     *
     * A host with no pin returns false: the caller must then fail the
     * connection, never fall back to trusting it.
     */
    fun matches(context: Context, host: String, certificate: SslCertificate?): Boolean {
        val pinned = get(context, host) ?: return false
        val cert = x509From(certificate) ?: return false
        return try {
            fingerprintOf(cert) == pinned
        } catch (_: Exception) {
            false
        }
    }
}
