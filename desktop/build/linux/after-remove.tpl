#!/bin/bash
# The .deb's post-remove script: electron-builder's own after-remove.tpl
# (app-builder-lib 25.1.8), plus removing the AppArmor profile that
# after-install.tpl may have added.  Templated the same way.

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# (Sozvon) On an upgrade this runs between unpacking the new version and its
# after-install, which puts the profile straight back.
profile='/etc/apparmor.d/${executable}'
if [ -f "$profile" ]; then
    if hash apparmor_parser 2>/dev/null; then
        apparmor_parser --remove "$profile" 2>/dev/null || true
    fi
    rm -f "$profile"
fi
