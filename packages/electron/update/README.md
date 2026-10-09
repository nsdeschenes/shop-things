# Original-user restart supervisor

`restart-supervisor.py` is normal-user infrastructure. It performs no package
mutation. `startRestartSupervisor()` is intentionally not called by the shipped
updater until the complete installation transaction gate is wired.

## Bootstrap layout and prerequisites

Package the source as `resources/update/restart-supervisor.py`. The bootstrap
package hook must install it root-owned, mode 0755, at
`/usr/lib/shop-things/update-supervisor`; each containing directory must
be root-owned and not writable by ordinary users. Invoke it with the fixed
`/usr/bin/python3 -I` argument vector. Declare `python3`, `python3-gi`, and
`gir1.2-gtk-3.0` dependencies. A working GTK3 desktop session is checked before the
supervisor announces readiness. Missing prerequisites disable restart/update
installation; there is no terminal, shell, or root Electron fallback.

The fixed normal-user executable is `/opt/Shop Things/shop-things`, matching the
product name and executable configured in electron-builder. Before launch the
supervisor checks fixed system dpkg records, the configured ARM64 target version,
package ownership of that executable, and protected file/directory permissions.

## Protocol and durable records

Main starts the supervisor before invoking the privileged helper. Its one bounded
stdin JSON request contains exactly `protocol: 1`, `attemptId` (UUID), `oldPid`,
`oldStart` (Linux `/proc` start identity), and the private `updatesDirectory`.
It must be started by that original application PID. The supervisor's bounded
stdout acknowledgment is `{protocol:1,type:"ready",attemptId}`. Main cannot
choose an executable, command arguments, or privileged operation.

Per-attempt files live beneath `<updatesDirectory>/<attemptId>/`, owned by the
original user with private permissions. `supervisor.lock` uses exclusive creation;
the same attempt cannot be replayed after supervisor/session loss. `launch.json`
is atomically replaced and file/directory-fsynced. It records a launch phase,
separate installation outcome, bounded diagnostics, and the launched PID/start
identity. It remains available for next-manual-launch reconciliation. Missing or
unfinished launch records do not imply either readiness or installation success.

After independently verified, durable installation success, main must atomically
persist and fsync `install.json` **before the old app exits**. Its strict schema is:

```json
{
  "schemaVersion": 1,
  "attemptId": "b7f650aa-0c51-4d68-a940-7f1472b86b46",
  "outcome": "installed",
  "manifestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "appVersion": "0.4.0",
  "packageName": "shop-things",
  "packageVersion": "0.4.0-1",
  "architecture": "arm64"
}
```

This user receipt confers no privileged authority. The supervisor checks it and
fresh, fixed `/var/lib/dpkg` package records after the old process exits. An
unverified, corrupt, missing, or incompatible receipt cannot authorize launch.
The helper's private root journal is never read by the ordinary-user supervisor.

The supervisor launches the fixed application once, retaining the desktop session
but removing runtime injection variables. A private mode-0700 temporary directory
holds a mode-0600 Unix socket. Only the actual child's PID, original UID, bounded
attempt ID, and random launch token can acknowledge readiness. The credentials
travel in `SHOP_THINGS_RESTART_SOCKET`, `SHOP_THINGS_RESTART_TOKEN`, and
`SHOP_THINGS_RESTART_ATTEMPT`, are consumed after acknowledgment, and never enter
the renderer bridge.

Main invokes `acknowledgeRestartReady()` only after package reconciliation,
startup database checks, and the document-authorized `app.ready({})` notification
from mounted application/database-recovery UI. An exited/failed child produces a
native GTK3 recovery dialog with diagnostics and a fixed normal-user launch action.
After 120 seconds a live slow/stuck child receives guidance without another launch.
The manual launch action is unavailable while the automatic child remains alive.

Call the returned supervisor handle's `cancel()` only for a proven reversible
pre-mutation failure. After mutation starts, losing the document or supervisor
must leave package reconciliation in control of the held lifecycle lease.

## Evidence

`test/restartSupervisorFixtures.py` runs real original-user child processes,
private IPC and durable files. It substitutes only external package/executable and
GTK boundaries, and covers exit ordering, readiness, wrong-token/other-process
rejection, root refusal, malformed/missing receipts, dpkg mismatch, launch failure,
live timeout without duplicates, environment retention, and replay rejection.
`test/restartReadiness.test.ts` uses a real private socket for the main handshake.
These supporting fixtures do not establish privileged package installation,
packaged ARM64 launch, or GTK desktop proof. Run the controlled supervisor fixture
against the packaged source and actual GTK3 desktop on the required ARM64 devices;
record package ownership, runtime versions and outcomes before release approval.

## Interrupted evidence resolution

The administrator-only fixed `/usr/lib/shop-things/update/resolve-update` command
loads protected `update/recovery.py`, holds the updater and genuine POSIX
frontend/dpkg locks, and settles only an intact signed retained baseline/actual
plan against fresh complete installed state. It neither authenticates through the
updater action nor performs any package operation. It retains the original policy
digest and verified key fingerprint so target key rotation cannot change the
original attempt's authority. Private journal, read-only receipt and index precede
clearing public pending state. Missing evidence remains recovery. See the
[operator recovery runbook](../../../docs/updates/recovery.md).

The existing document-authorized `update.retry({attemptId})` action performs only
a read-only recheck while main owns package recovery. On independently proven
unchanged state it aborts the retained lease and restores the original draft; on
verified installed state it finalizes that lease and continues the existing
supervisor. A fresh startup checks protected package state before remembered DB
opening and renderer readiness. No user progress record grants authority.

External interruption fixtures additionally cut real old-app and supervisor
processes at durable intent and the spawn-before-PID gap. Exclusive admission
refuses replay even when a child PID was never durably recorded. This process-loss
evidence is separate from actual desktop authentication and VM power-loss proof.
