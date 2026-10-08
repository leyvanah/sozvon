#!/bin/bash
# The .deb's post-install script: electron-builder's own after-install.tpl
# (app-builder-lib 25.1.8), plus the AppArmor block at the end.  Templated by
# electron-builder: ${executable} and ${sanitizedProductName} are filled in,
# and any other dollar-brace in this file is an error, so shell variables
# below are written without braces.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# (Sozvon) Ubuntu 24.04 and later let AppArmor forbid unprivileged user
# namespaces, which Chromium's sandbox needs.  The test above cannot see that:
# it runs as root, whom the restriction does not apply to, so it leaves
# chrome-sandbox unprivileged and the app then dies on its first start with
# "No usable sandbox".  The fix the browsers ship is a profile that lets this
# one binary create user namespaces; if it cannot be loaded, fall back to the
# setuid sandbox instead, so the app starts either way.
profile='/etc/apparmor.d/${executable}'
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] &&
   [ -f /etc/apparmor.d/abi/4.0 ]; then
    cat > "$profile" <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile ${executable} /opt/${sanitizedProductName}/${executable} flags=(unconfined) {
  userns,

  include if exists <local/${executable}>
}
PROFILE
    if ! { hash apparmor_parser 2>/dev/null && apparmor_parser --replace --write-cache --skip-read-cache "$profile"; }; then
        rm -f "$profile"
        chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
    fi
fi
