# Qualifying an ARM64 update

Qualification remains pending until the actual user target desktop, a clean ARM64
Debian/Ubuntu graphical desktop, and a disposable full-system ARM64 VM pass their
required cases. Native CI, containers, Xvfb and controlled process fixtures provide
specific supporting proof; they cannot replace those roles. This task creates a
draft implementation PR and does not authorize release, signing, settings changes,
package work on the operator's real system, or default-branch merges.

## Prepare an approved candidate

After independent review and a future authorized main merge, test one exact full
main commit SHA. Record the head SHA and the actual tested checkout SHA: PR runs
usually test a merge commit, so a passing PR head does not substitute for main-push
proof. Desktop, script tooling and Restricted update package transaction must all
have successful main-push runs at the exact candidate SHA. The APT workflow runs
on every main commit, including release metadata commits.

The separate `qualification-signing.yml` workflow signs only a nonpublishing
bundle of the final accepted installer, manifest, signature, checksum, approved
public policy and provenance. It has read-only repository permissions and uses the
same protected `update-signing` environment as publication. It requires the merged
release PR, exact current main dispatch SHA, successful native artifact/CI gates
and observed independent reviewer approval. No qualification variable is needed
for this bundle; device qualification requires its exact signed bytes first.

An authorized operator must configure human User reviewers, prevent self-review,
main-only deployment branches, immutable releases, and disable administrator bypass.
The supported environment REST API does **not** expose the bypass toggle. Tooling
reports that setting as unobservable and requires actual approved history from an
allowlisted human distinct from both run actors. Missing, Team, pending, rejected,
ambiguous or rerun approval fails closed. Start a new first-attempt dispatch after
failure; do not attribute run-scoped approval to a rerun. Each signing workflow has
one signing job and one environment use. The check binds approval to the run and
candidate SHA; it does not invent a deployment ID or prove the UI approval route.
See the [approval-history API](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run)
and [environment protection documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

Dispatch inputs must equal `github.sha` and API `run.head_sha`; checking out an
older input SHA does not change the approved dispatch SHA. If main advanced, test
and independently approve the new candidate rather than weaken this binding.
Private keys are supplied only to the protected signing step; public-key policy
must already be embedded in the exact accepted installer. Never rebuild the
candidate or insert policy after acceptance. Publication separately retains
`UPDATE_RELEASE_QUALIFIED_SHA == RELEASE_SHA` and all exact-SHA/approval checks.
Neither report tooling nor this workflow sets that variable or publishes anything.

## Required observations

Use synthetic databases for destructive/fault cases. Retain exact OS/kernel,
architecture, app/Debian/helper/APT/dpkg/python3-apt/polkit/GTK/Electron/Turso versions;
ordinary UID, actor PID/start identity, target installer length and SHA256, exact
manifest/signature/checksum/public-policy bytes and approval/artifact provenance.
Do not publish real database bytes, passwords, private keys or arbitrary process
environments. Preserve protected root journal/global/caller receipt generations,
full package inventories, actual v3 batches/archive hashes and external cut events.

| Role            | Required case IDs                                                                                                                                                                                         | Actual scope                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `user-target`   | bootstrap, two-version-upgrade, authentication, draft-guard, original-user-restart, packaged-database                                                                                                     | User's actual ARM64 graphical desktop; explicit preparation and authorization                         |
| `clean-desktop` | bootstrap, legacy-transition, two-version-upgrade, authentication, capabilities, staging-attacks, package-policy, unchanged-partial, draft-guard, original-user-restart, launch-faults, packaged-database | Fresh ARM64 Debian/Ubuntu graphical desktop; actual agent/helper/locked APT/native restart            |
| `disposable-vm` | actor-interruption, power-loss, package-reconciliation, database-storage-faults, database-power-loss                                                                                                      | Full ARM64 guest/kernel and externally controlled process/power/storage faults; separate fresh clones |

Authentication includes success, cancel, deny and absent graphical agent with no
terminal fallback. Package cases include all archive/repository/relationship and
lock restrictions, pending/partial recovery and explicit evidence settlement;
ordinary user records never authorize package use. Draft cases preserve Save,
deferred discard and the same session on proven unchanged cancellation. Restart
cases distinguish installed receipts from launch diagnostics, ordinary-user child
identity, readiness, live slow child and no automatic duplicate relaunch. Follow
[recovery instructions](recovery.md) for administrator evidence settlement; it does
not perform package work or grant broad repair authority.

Packaged database cases cover remembered startup and later open, pending/no
migrations, committed journal contents, real external writer exclusion, private
unique verified/fsynced snapshots, failed migration retention, separate-copy
restore, older-app rejection, active session preservation, actual ENOSPC/integrity/
fsync/lock faults and cold power recovery. The extended shipped smoke runner proves
actual packaged exports/addon/migration files and retained ownership before/after
backup and migration with an external writer positive control. It does not claim
an unwitnessed overlap inside `openExistingDatabase`, real ENOSPC/fsync EIO, or power
loss. Its deliberately failing SQL is an explicitly recorded temporary copy of
shipped migrations, not the original positive migration set. A storage-path failure
is not ENOSPC. Those missing system faults stay pending.

First-time recursive backup-directory creation syncs the source directory, backup
root and its parent. Do not infer that every newly created higher appData ancestor
is durable: verify existing-directory assumptions and externally cut a fresh
appData scenario before claiming that power-loss guarantee. Electron directory
creation alone is not recorded fsync evidence.

## Collect and review bounded evidence

Keep a private evidence root with regular files and no symlinks. `qualify-update.ts`
accepts a strict duplicate-rejecting schema1 input and hashes referenced unchanged
files (512 files maximum, 8 MiB per case log, 1 MiB per JSON, installer at most
1 GiB). Unknown fields, paths escaping the root, malformed identities, mismatched
SHA/bytes and wrong CI provenance fail closed. It verifies the four signed assets,
embedded public policy, both packaged acceptance records, and successful exact-SHA
main-push CI records including actual APT. JSON input describes observations; it
cannot establish their truth or grant privileged authority. Independent reviewers
must inspect real immutable logs and run/artifact identities, not trust a claimed
`actual` label or a hash alone.

A minimal pending input is:

```json
{
  "schemaVersion": 1,
  "testedSha": "<40 lowercase hex>",
  "bundle": null,
  "runs": [],
  "roles": [],
  "cases": []
}
```

When supplied, `bundle` has exactly `directory`, `policy`, `acceptance`, `approval`,
and `run` relative paths. Assets directory contains only the four final signed
files. Policy is approved-policy.json; acceptance is schema3 acceptance.json;
approval is signing-approval.json; run is a genuine successful first-attempt
qualification-signing run GET response. Fetch it after that workflow completes.
Each `runs` row is `{workflow,runId,evidence}` for desktop.yml, scripts.yml or
update-apt.yml; evidence is the genuine run response captured from the API. Each
`roles` row has `{role,platform,architecture,os,kernel,versions,security}` with linux/arm64
and security containing exactly apparmorRestriction, apparmorEnabled, userNamespaces
and factorySettings (verified or otherwise explicitly pending). Version fields contain exactly app, package, helper, apt, dpkg, pythonApt, polkit,
gtk, electron and turso. Each `cases` row has exactly role, case, status
(passed/failed/pending), execution (actual/controlled), testedSha, installerSha256,
evidence (relative file paths) and details (bounded single-line observation).

Run without package mutation:

```sh
node --experimental-strip-types scripts/qualify-update.ts /absolute/private/evidence input.json /absolute/private/new-report.json
```

The collector writes a new private report with hashes and explicit missing/failed
case IDs. Missing bundle/roles/evidence or controlled fixtures remain pending;
recorded failures make the report failed. There is no skipped result. Preserve
unexecuted cases and required roles instead of selecting only successful cases.
To execute the existing packaged backend smoke on the exact already-built native
artifact, use `SMOKE_REPORT_PATH=<private-report> pnpm --filter electron test:smoke`.
Retain its runtime/inventory/stdout/stderr and exact addon/installer/migration hashes.
This run-as-node seam is separate from real packaged GUI recovery/readiness proof.

Only after every mandatory actual observation and exact final-byte provenance is
reviewed may an authorized operator separately set the protected qualified SHA.
A complete report still does not authorize that action, key provisioning, release
approval or publication. Missing target desktop, approved bundle or VM fault
surfaces remains an explicit pending gate.

The preexisting renderer/portable CI setup relaxes Ubuntu's AppArmor user-namespace
restriction. The new installed GUI phase records the initial setting, restores it
for fixed installed app execution, then returns to the documented portable test
topology. Reports retain actual kernel/AppArmor/user-namespace values. Xvfb CI still
does not count as the mandatory real desktop or factory-system qualification.
