# Fixed helper verification and bootstrap

The bootstrap Debian package installs root-owned files at fixed paths:
`/usr/lib/shop-things/updater-helper`, `/usr/lib/shop-things/update-supervisor`,
`/usr/lib/shop-things/update/policy.json`, `/usr/lib/shop-things/update/identity.json`
and `/usr/share/polkit-1/actions/com.shopthings.app.update.policy`. Protected
ancestors reject ordinary-user writes and symlinks. The action grants only active
administrator authentication for the fixed helper, with no retained authorization.
Debian hooks preserve electron-builder's existing alternatives/sandbox/AppArmor
behavior and append the fixed bootstrap install. Removal preserves user data,
databases, snapshots and private updater state. It never removes legacy electron.

Dependencies retain builder defaults and add Python3, Python GI/GTK3, pkexec,
polkitd, APT/dpkg, OpenSSL, ACL tools and GLib tools. Capability checks inspect
configured ARM64 shop-things identity/executable ownership, protected files and
protocol/policy, system tools, polkit action reachability and a usable GTK session.
No distribution-name allowlist or automatic authentication probe is used.
Graphical agent registration cannot be established by portable read-only polkit
APIs; explicit pkexec performs runtime authorization with
`--disable-internal-agent`, preventing terminal fallback. Missing prerequisites
leave discovery visible and explain why installation is unavailable.

Normal builds generate `resources/update/identity.json` from Electron package
metadata with exact `{schemaVersion:1,packageName:"shop-things",appVersion}`.
Bootstrap installs this separately from the unchanged three-field public policy.
Approved public policy is provisioned before package build/acceptance, never after
an installer was tested. Ordinary draft builds lacking policy remain incapable;
no production test key is supplied. Normal build and the direct builder beforePack
entry both validate any supplied public policy before packaging; private PEMs
fail closed. See `docs/signed-updates.md`.

## Protocol and verification

Main invokes only `/usr/bin/pkexec --disable-internal-agent
/usr/lib/shop-things/updater-helper`. The isolated Python executable accepts one
bounded JSON install request (100000 bytes maximum), exactly:

```json
{
  "protocol": 1,
  "attemptId": "b7f650aa-0c51-4d68-a940-7f1472b86b46",
  "manifest": "canonical base64 raw UTF8 bytes",
  "signature": "canonical base64 raw64 signature",
  "candidatePath": "/main-owned/download/artifact.deb"
}
```

All main input remains untrusted. No operation selector, executable/options/key
parameter, verification mode, test flag, shell or elevation fallback exists.
Helper validates installed public SPKI Ed25519 policy, verifies exact manifest
bytes before strict duplicate-free schema parsing, then checks independent fresh
configured dpkg baseline and protected installed app identity. Both app and Debian
versions must advance. The input is pinned with no-follow directory/file handles;
only regular caller-owned private single-link files are accepted. Replacement and
metadata changes fail. Exclusive root-only 0700 attempt staging and 0600 files
below `/var/lib/shop-things-updater/<attemptId>/` prevent replay/substitution.
The copied bytes, length/hash and staged embedded Debian control metadata are
verified. A bounded streaming tar reader reads only the fixed identity member,
rejecting duplicates, links, unsafe paths and excessive expansion; it never
extracts archive paths to the filesystem. Target identity appVersion must match
the signed manifest. Release signing uses that same archive reader.

The shipped helper emits one bounded five-field outcome: protocol, type,
attemptId, outcome (`installed`, `unchanged`, `uncertain` or `rejected`) and finite
errorCode. Main never treats stdout or an exit code as installation evidence; it
reads independently durable protected receipts and fresh package state. Internal
`verify_request()` remains a nonmutating signed-byte verification seam for tests;
there is no shipped verify operation. Legacy controlled verification composition
requires an explicit nonmutating fixture and cannot invoke the production helper.

`test/updateHelperFixtures.py` exercises real OpenSSL Ed25519 signatures,
dpkg-built archives, safe filesystem copies and archive streaming, replacing only
fixed protected-owner/path and installed-system baseline boundaries in a separate
fixture process. It checks tampering, unsafe/symlink/replaced files, invalid
protocol/identity/trust, private keys, replay and target app mismatch. Backend tests
use actual ActionService/DraftCoordinator/database for blocked admissions,
restoration and failed reopen. Controlled Electron acceptance composes the real
transfer/preload/IPC/document draft/database with an external auth/helper fixture.
These checks are not privileged packaged ARM64/polkit proof. Actual root-owned
bootstrap resource ownership/action/prerequisite inspection, cancelled/denied or
missing graphical agents and staging attacks through real pkexec require the
separate disposable ARM64 desktop fixture/qualification gate. No local host package
mutation or authentication was performed locally. Production installation requires every concrete capability and transaction gate.

For disposable packaged ARM64 qualification, provision an operator-generated
**test-only** publisher public key before building/installing the bootstrap fixture.
The explicit `scripts/helperPackagedAcceptance.ts` runner requires
`HELPER_ACCEPTANCE_DISPOSABLE_INSTALL=1`, `HELPER_ACCEPTANCE_TEST_KEY_FILE`,
`HELPER_ACCEPTANCE_INSTALLER_FILE` (the complete already-built qualified .deb),
`HELPER_ACCEPTANCE_TARGET_VERSION` and `HELPER_ACCEPTANCE_TARGET_PACKAGE_VERSION`.
It invokes actual scoped authentication and performs a real upgrade; never run it
on the user's ordinary installation. Subsequent staged attacks must preserve the
new package inventory. It never provisions trust or supplies another helper
operation. Graphical cancellation/denial, missing agents, full supervisor restart
and VM power interruption remain separate qualification, not inferred from this
runner's success. No local ARM64 desktop execution is claimed.

## Restricted installation and independent recovery (#181)

The same fixed install request now continues to a real APT transaction. It loads
only protected `/usr/lib/shop-things/update/transaction.py` and system
`python3-apt` through isolated Python. APT receives a private root configuration,
fixed argv, sanitized environment and one fixed protected protocol-v3 hook at
`/usr/lib/shop-things/update/apt-hook`. APT internally uses its documented static
shell hook mechanism; no caller text becomes a command. The hook checks genuine
owned APT ancestry, every actual archive/index hash and Debian relationship against
the installed baseline. Simulation output never authorizes dpkg. Unsupported APIs,
source trust bypasses, dirty package states and prohibited actions fail closed.

Root journal/staging remain `0700` below `/var/lib/shop-things-updater`. The separate
root-owned `/var/lib/shop-things-updater-receipts/global.json` is a minimal public
read-only index: schema, initialization marker, monotonic generation and unresolved
attempt UUID/original UID. It reveals no private package inventory or root staging
paths. It prevents another desktop UID, or deletion of user progress files, from
hiding a system-wide pending transaction. Per-UID directories below `users/` grant
only that original numeric UID read/search with named-user POSIX ACLs. Root owns
all ancestors/receipts and denies ordinary-user replacement/removal/writes. Caller
receipts contain independent baseline, every validated plan batch, final package
state and finite outcome; archive paths are omitted from this projection.

Bootstrap initializes only genuinely new projection state. Missing/corrupt existing
state is never reset to an empty index. Every accepted attempt publishes pending
index/intent, then durable validated plan before any hook permits mutation; final
root outcome and caller receipt precede pending removal. Atomic files and containing
directories are fsynced. The bounded inventory refuses excess retained attempts
before accepting another transaction; administrator attention is required rather
than silently deleting unresolved evidence. Actual ACL qualification belongs in
native package-policy CI and disposable desktop/VM qualification.

Main reads this projection without authentication or a helper operation, compares
fresh complete package inventory, and gates remembered database opens before
`ActionService.start()`. A coherent unchanged outcome restores the same session and
retained draft. Authentication cancellation without a new receipt is reversible
only with an initialized coherent unchanged protected generation/no pending state,
matching fresh full baseline, and confirmed fixed child exit. Helper loss, timeout,
partial package state or missing evidence retains the held lease and package recovery.
Main never kills a possibly mutating helper; its fixed helper does not daemonize or
forward package-manager exit codes as authentication status. Exit codes alone are
not evidence. Popover closure does not cancel; normal quit/reload cannot interrupt
an owned install. No root Electron, broad repair, downgrade/replay or legacy removal.

After independent installed outcome, main publishes user diagnostics, finalizes
old admissions for exit and lets the already-ready original-user supervisor launch
one child. The supervisor independently reads protected receipts and reconciles
all relevant configured packages; user `install.json` is diagnostics only. New-app
readiness follows package and database startup checks or mounted database recovery,
never mounted package recovery. Install success and launch outcome stay separate.
Unknown child identity after spawn cannot authorize automatic relaunch.

`update-apt.yml` builds a pinned native ARM64 disposable image without host system
mounts or privileged host mode. Its real signed fixture repository exercises allowed
dependency installation, relationship denial, trust bypass, holds, dirty state,
real lock contention and partial configuration failure with independent sentinels.
It records actual APT/python-apt versions, root plan and receipt generations. This
lane cannot establish graphical polkit/session behavior or abrupt VM power durability;
those remain separate #185 qualification. The explicit packaged helper runner now
requires `HELPER_ACCEPTANCE_DISPOSABLE_INSTALL=1`: its positive case really mutates
a disposable fixture, rather than claiming a production verification-only operation.
