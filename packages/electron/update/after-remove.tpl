#!/bin/bash
# Default Electron packaging hook derived from electron-builder 26.15.3.
# MIT notice: resources/update/ELECTRON-BUILDER-LICENSE.

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
# Preserve private journals, receipts, user settings, databases and backups.
case "$1" in
  remove|purge)
    rm -f /usr/lib/shop-things/updater-helper /usr/lib/shop-things/update-supervisor
    rm -f /usr/lib/shop-things/update/policy.json /usr/lib/shop-things/update/identity.json
    rm -f /usr/share/polkit-1/actions/com.shopthings.app.update.policy
    ;;
esac
