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
no production test key is supplied. See `docs/signed-updates.md`.

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

Successful verification emits one bounded outcome:
`{protocol:1,type:"outcome",attemptId,outcome:"install-disabled",errorCode:"INSTALL_DISABLED",manifestDigest,appVersion,packageVersion,baseline:{appVersion,packageVersion,architecture:"arm64"}}`.
Failure emits `{protocol:1,type:"outcome",attemptId?,outcome:"rejected",errorCode:"VERIFICATION"}`.
No raw inputs, keys, candidate/root staging paths or tool output enter diagnostics.
A rejection does not promise an independently established unchanged package state
for a future mutating helper. This helper contains **no package mutation**.

Production installation remains disabled until #181. The main-only
`verifyUpdateUnderLease()` composition holds actual draft/database protection
before invoking authentication and aborts/reopens afterward. Its ability to abort
any outcome depends specifically on this nonmutating helper version; #181 must
replace it with independent durable evidence and owner-controlled recovery. Failed
reopen uses existing database recovery with retained draft. The controlled
acceptance entry injects only external auth/helper behavior, never a production
bridge operation or environment switch.

## #181 handoff and evidence

Reuse the fixed single request and exclusive protected staging path
`<attempt>/artifact.deb`, retained manifest.json/manifest.sig, target identity,
manifest digest and independently inspected baseline. #181 owns the actual APT
protocol-v3 locked plan, prohibited transaction checks, durable private journal,
root-authentic outcomes, supervisor ordering and production enablement. APT's
specified hook mechanism internally executes its one fixed protected hook command
through a shell; the helper must never derive that command from input or directly
invoke a shell. No stale simulation is transaction authority.

ACL tools are packaged for #181's separate root-owned projection boundary
`/var/lib/shop-things-updater-receipts/`: bounded minimal public pending index and
private per-UID named-user read/search-only ACL receipts. #181 owns initialization,
schema, ACL capability checks, crash durability and startup reconciliation. Root
journals/staging remain root-only. No new privileged startup/read operation or
user-authoritative progress record is introduced here.

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
mutation or authentication was performed; production installation is still off.

For disposable packaged ARM64 verification, provision an operator-generated
**test-only** publisher public key before building/installing that bootstrap
fixture. Retain its private fixture key privately on that disposable desktop.
Run `scripts/helperPackagedAcceptance.ts` as the original graphical user with
`HELPER_ACCEPTANCE_TEST_KEY_FILE` and a strictly newer stable
`HELPER_ACCEPTANCE_TARGET_VERSION`. The runner validates the protected installed
helper matches the reviewed source, invokes the actual scoped pkexec repeatedly
(with administrator approval), checks real valid/tampered/symlink requests and
compares the complete dpkg inventory before/after. It never writes installed trust,
installs packages or supplies an alternate helper operation. Authentication
cancellation/denial and missing-agent scenarios require separate interactive runs
and retained results; they are not inferred from this runner's success. This
fixture has not been executed locally on the x64 host.
