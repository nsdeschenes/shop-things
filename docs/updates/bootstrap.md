# Manual Linux ARM64 bootstrap

The app cannot update the old `electron` package itself. An operator installs an
approved `shop-things` ARM64 Debian package once; subsequent updates use the
protected helper. This procedure requires the application user's consent and an
operator who can install packages. It never changes the default database location.

## Inspect before changing packages

Use a trusted checkout of this procedure and Node 26 to run the read-only verifier
as an ordinary user:

```sh
node --experimental-strip-types scripts/verify-bootstrap.ts
```

The CLI takes no path, identity, trust, or mutation options. It reads real dpkg
metadata and root-protected installed files. It does not authenticate, stop the
application, remove packages, or install anything. `shutdownConsent` always remains
`operator-required`. Its result describes the installation, not a live consent or
complete updater capability check:

- `fresh`: none of the known shared application files exists. Use normal APT
  installation after reviewing the requested transaction.
- `verified-legacy`: configured ARM64 `electron` version `0.3.1`, the known Shop
  Things maintainer/homepage/description, exact known executable/ASAR/native
  backend/desktop bytes, known maintainer-script bytes, and exclusive dpkg
  ownership agree. Only this result
  identifies a package eligible for the legacy removal procedure below.
- `unrelated-electron`: do not remove `electron`. A separate application may
  coexist with `shop-things` when its owned paths do not conflict. Resolve actual
  conflicts separately with its owner.
- `verified-bootstrap`: configured ARM64 `shop-things`, protected installed
  identity/helper/supervisor/action files and packaged runtime identity agree.
  Present publisher policy must be protected, duplicate-free, and contain only
  approved public Ed25519 SPKI keys. Missing policy leaves self-updating disabled.
- `unsafe`: stop. Modified files, incomplete dpkg configuration, conflicting
  owners, changed runtime identity, or unprotected resources need investigation.
  Do not force this verifier to accept them.

The known legacy reference is the published
[v0.3.1 ARM64 Debian installer](https://github.com/nsdeschenes/shop-things/releases/tag/v0.3.1),
SHA-256 `5cb87baef6c434b22f61f36178674ad3fe99569020a9ab0af28a199f2156bf11`.
This historical checksum identifies inspected bytes; it grants no authority to a
future installer. Obtain the bootstrap package and public publisher trust through
the approved release process and verify its release evidence before installation.
Do not provision private signing material on the target.

## Obtain normal shutdown consent

Ask the application user to finish their work and use normal Quit. If the draft
prompt appears, Stay must leave the application and draft usable. Save or discard
only with the user's explicit choice, then Quit again. Verify that Quit completed
and there is no remaining Shop Things process. Process absence alone does not
prove that the user consented: a crash, forced kill, or an unrelated process check
is insufficient. Do not use `kill`, task-manager termination, or package removal
as a substitute for protected shutdown. If consent or a normal exit cannot be
established, stop and recover the application before continuing.

Record the actual runtime user-data directory, remembered database path, and
retained migration backups without editing them. The packaged runtime name stays
`electron`; on Linux the default is `$XDG_CONFIG_HOME/electron` or
`$HOME/.config/electron`. Product branding alone does not establish that path.
Respect existing environment overrides and inspect the actual application path.
Database files can live outside userData. Preserve ownership, contents, remembered
selection, retained backups, and diagnostic/update records. Do not move them into
`shop-things`, delete them, or start the app as root.

## Replace only verified legacy, then install

Immediately after the normal exit, run the verifier again. Continue with removal
only if it still reports `verified-legacy`. Prevent another app launch during the
operator transition. Remove that exact package with normal dpkg behavior:

```sh
sudo dpkg --remove electron
```

Finish removal before installing the new package. The legacy removal script
changes the shared `shop-things` alternative and `/etc/apparmor.d/shop-things`;
removing legacy after the new installation can undo the new package's launch
integration. Do not purge application data, use autoremove, remove an unrelated
`electron`, or introduce generic Conflicts/Replaces/force-overwrite rules.

Install the reviewed local ARM64 bootstrap installer with APT, replacing the
example path with the exact approved artifact path:

```sh
sudo apt-get --no-remove install '/absolute/path/to/approved-shop-things-linux-arm64.deb'
```

Review dependency/configuration errors rather than using force flags. Required
system dependencies include APT/dpkg, system Python and the protected helper's
Python APT bindings, polkit/pkexec, GTK/GObject, ACL tools, and public crypto tools.
Do not remove the updater or make its protected directories writable to repair a
failure. The package provisions `/usr/lib/shop-things/updater-helper`,
`/usr/lib/shop-things/update-supervisor`, protected resources under
`/usr/lib/shop-things/update/`, the fixed polkit action, and private transaction
state under `/var/lib/shop-things-updater/`.

Rerun the verifier, then launch as the original ordinary desktop user. Confirm the
same runtime name and userData, remembered database/customer records, and retained
backups. Any first-open migration uses the durable backup gate. Check update
capability in the actual supported desktop session. Package identity verification
cannot guarantee that a desktop authentication agent is ready; an explicit Update
must fail safely before mutation if runtime authentication is unavailable.

## Controlled acceptance and remaining qualification

The `desktop.yml` native ARM64 lane runs `acceptance/bootstrap/run.mjs` after the
normal package smoke checks. Root package operations run only inside disposable
Docker containers with no privileged mode or host system mounts. It records the
actual runner/OS, pinned image digest, package hashes, APT/dpkg versions, inventory,
owned executable and alternative, and retention bytes/UIDs. Fresh installation,
exact legacy removal-before-install, and unrelated `electron` coexistence are
separate cases. Container sentinels prove package retention and ownership, not
native database validity.

The same harness launches the exact legacy and candidate archive executables as
the ordinary runner user, with a real Turso database created using legacy
migrations. It observes actual `electron` userData and remembered selection,
retained backups/customer records, legacy and candidate Stay followed by approved protected Quit, and retained
first-open migration snapshots when histories differ. These extracted runtime checks are separate
from installed container package checks; no container GUI/authentication claim is
made. Reports are retained under the job's `bootstrap/` acceptance artifacts.

A supported user desktop's real polkit/helper/APT/supervisor transition and a
disposable ARM64 VM's genuine power-loss recovery still require target access.
Hosted process/container evidence cannot substitute for those qualification
results. Run the target qualification procedure before claiming supported-device
release readiness.
