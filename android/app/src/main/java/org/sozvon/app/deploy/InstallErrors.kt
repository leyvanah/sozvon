package org.sozvon.app.deploy

import org.sozvon.app.R

/**
 * What a failed install means, in the user's words (tasks#19).
 *
 * contrib/install.sh stops for a small, fixed set of reasons and writes each
 * as a stable code to its state file.  Its own message is English, written
 * for someone running the script by hand, and may name flags this app does
 * not offer -- so it is shown below the sentence, for a bug report, and never
 * instead of it.  Codes rather than matching the English text: that would
 * break the first time a message is reworded.
 *
 * The desktop app says the same in desktop/src/renderer/install-errors.js;
 * desktop/test/install-errors.test.js checks that this map, both string
 * files and the desktop table know every code the installer can write.
 */
val INSTALL_ERRORS: Map<String, Int> = mapOf(
    "not-root" to R.string.install_error_not_root,
    "no-systemd" to R.string.install_error_no_systemd,
    "unsupported-os" to R.string.install_error_unsupported_os,
    "unsupported-arch" to R.string.install_error_unsupported_arch,
    "packages" to R.string.install_error_packages,
    "system-setup" to R.string.install_error_system_setup,
    "port-in-use" to R.string.install_error_port_in_use,
    "version-unknown" to R.string.install_error_version_unknown,
    "download-failed" to R.string.install_error_download_failed,
    "checksum-mismatch" to R.string.install_error_checksum_mismatch,
    "unpack-failed" to R.string.install_error_unpack_failed,
    "public-ip-unknown" to R.string.install_error_public_ip_unknown,
    "certificate-failed" to R.string.install_error_certificate_failed,
    "service-failed" to R.string.install_error_service_failed,
    "rolled-back" to R.string.install_error_rolled_back,
    "not-answering" to R.string.install_error_not_answering,
    "port-forward" to R.string.install_error_port_forward,
    "certificate-rate-limited" to R.string.install_error_certificate_rate_limited,
    "internal" to R.string.install_error_internal,
    "aborted" to R.string.install_error_aborted,
)
