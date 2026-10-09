# Interrupted package updates

Shop Things keeps its database closed and ordinary actions disabled when protected
package evidence is missing, incomplete, corrupt, or disagrees with fresh package
state. A progress message, caller-owned `install.json`, the application version
alone, and an empty process list cannot resolve this state. Do not delete receipt,
journal, lock, or staging files to make the application start.

The protected records are `/var/lib/shop-things-updater/` (root only) and
`/var/lib/shop-things-updater-receipts/` (a small public pending index and root-owned
receipts readable only by their original user). The application shows **Check
again** only as a read-only evidence check through the existing update retry
operation. It does not download, authenticate, invoke the installer, or repair
packages during this check.

## Explicit administrator evidence resolution

An administrator may inspect the root pending index to identify the single
unresolved attempt. Keep all original evidence, including retained archives,
manifest, signature, policy and public keys. Wait for the fixed transaction and
system package manager to finish. Use the original user's live application session
if it remains available; its database lease and draft stay held during recovery.

Run the installed fixed entry explicitly, replacing the example UUID with that
protected attempt's identity:

```sh
sudo /usr/lib/shop-things/update/resolve-update b7f650aa-0c51-4d68-a940-7f1472b86b46
```

This separate administrator command has no polkit updater action. The application
never executes it or requests authentication for it. It accepts only an attempt
UUID and offers no path, command, key, repair, replay or package selector.

The command holds the updater lock and genuine POSIX frontend/dpkg locks. It
refuses a live owned APT process, revalidates the retained signed manifest against
the independently retained pre-mutation policy and verified key fingerprint, and
checks every archive in the recorded actual locked plan. A new installed policy
may rotate keys; it cannot substitute authority for the retained original policy.
Fresh inspection must cover the full relevant package inventory, automatic flags,
configured ARM64 application, installed identity and executable ownership.

Only the complete intended configured state can produce a new durable verified
`installed` outcome. Only an empty validated plan and the exact unchanged baseline
can produce `unchanged`. An accepted nonempty plan followed by the old inventory
remains uncertain: current inventory cannot prove that no mutation occurred.
Partial packages, broken dependencies, missing trust or archives, multiple pending
attempts, and corrupt or incomplete records stay in recovery. A busy lock or any
failed check leaves pending evidence in place.

The command performs no package installation, removal, downgrade, replay or
repair. It publishes the verified private journal, original-user receipt and
receipt index with file and directory fsync, then clears the public pending entry
last. It preserves existing evidence and partial publication files. Success emits
a bounded JSON outcome. Failure reports that no package operation was performed;
it does not authorize a force option or broader updater action. Any necessary
system package repair remains a separate administrator operation, followed by
fresh evidence verification. If the original signed evidence cannot be recovered,
this command cannot manufacture an outcome; retain the records for investigation.

## Continue the application

After resolution, choose **Check again** in the original owner's application.
Verified unchanged state cancels the unused restart supervisor, reopens the same
database through its migration snapshot gate, and releases the original retained
draft. Verified installed state finalizes the held lease and exits for the existing
supervisor to launch the fixed installed application once. Repeated checks are
coalesced and settled continuations do not launch or finalize twice. An unchanged
package state with a database reopen failure enters database recovery and retains
the draft.

On a fresh launch, protected package reconciliation precedes remembered database
opening, migrations and ordinary admissions. There is no prior renderer draft
participant to consult. The running application version must match the fresh
protected installed identity before database checks proceed. Missing or forged
user progress records cannot influence admission.

A supervisor attempt has durable exclusive admission. If it dies after spawning a
child but before recording that child's PID, the surviving intent cannot prove
that no child exists and cannot authorize another automatic launch. Investigate
actual owned process identities before an explicit normal manual launch. Readiness
belongs to the exact child PID, private socket, attempt and nonce. A slow alive
child is never duplicated. Installation outcome and launch/readiness outcome are
separate records; a launch failure does not turn a verified install into failure.

Retained drafts survive reversible failures while their original application and
renderer remain alive. A process crash, logout or power loss does not persist an
unsaved draft. Saved databases and durable migration snapshots remain the recovery
sources; no crash-time draft persistence is promised.

## Evidence boundaries

Local tests use real filesystem publications, process identities, SIGKILL cuts,
Ed25519 signatures, retained archives and POSIX lock contention. They substitute
privileged ownership/ACL and system-package boundaries. The native ARM64 disposable
container lane separately runs the real fixed helper, v3 APT hook, authenticated
repository acquisition, dpkg and administrator resolver, with external ptrace
cuts before selected executables begin. Its `SYS_PTRACE` capability is confined to
those disposable containers; it adds no shipped test switch or public operation.

These process cuts do not prove desktop polkit authentication, graphical supervisor
notifications, logout semantics or VM power-loss durability. Those require the
separate controlled ARM64 desktop/VM qualification. The APT fixture records actual
runner/tool versions and outcomes; do not describe an authored or unexecuted lane
as successful qualification.

On a manual launch, private bounded `launch.json` history is read for an informational notice about an unfinished earlier restart and possible lost unsaved edits. This history cannot authorize package work, database admission or another launch. Missing, corrupt, nonprivate or excessive history is ignored; normal startup still independently checks the protected root package evidence. A completed latest readiness record suppresses the notice.
