# Signed Linux ARM64 update publication

The release tooling assembles and verifies an authorized four-asset release:
`shop-things-<version>-linux-arm64.deb`, `SHA256SUMS`,
`shop-things-update-v1.json`, and `shop-things-update-v1.sig`. Adding this tooling
does not qualify the updater for release. Real device, package-manager, GTK,
interruption, and packaged database gates from #168/#185 remain mandatory.
No production key or trust policy is committed with the implementation.

## Operator provisioning

1. Provision an Ed25519 publisher key through the approved secret-management
   process. Keep an offline encrypted backup with restricted recovery access.
   Record and independently verify the public SPKI fingerprint. Never store a
   private key in source, build artifacts, ordinary CI jobs, or client packages.
2. Configure repository variable `UPDATE_TRUSTED_PUBLIC_KEYS_JSON` as a JSON
   array of approved **public SPKI PEM** strings. Before build/acceptance, run
   `scripts/provision-update-policy.ts` with that variable. It exclusively creates
   ignored `packages/electron/update/policy.json` with
   `{schemaVersion:1,helperProtocol:1,trustedKeys:[...]}`. Private PEMs are rejected,
   even though Node's public-key conversion can accept private inputs.
3. Bootstrap packages `resources/update/policy.json` and installs it root-owned,
   mode 0644, at `/usr/lib/shop-things/update/policy.json`. The helper and main
   use that installed policy. Provisioning after the accepted package is built is
   prohibited: signing extracts the policy from the tested installer and requires
   exact agreement with the approved public policy.
4. Create the dedicated `update-signing` GitHub environment. Require independent
   reviewers with self-review prevented, restrict deployments to the single
   `main` branch, and disable administrator approval bypass. Store
   `UPDATE_SIGNING_PRIVATE_KEY` **only as an environment secret**, never an
   ordinary repository/organization secret. Protect workflow/signing-tool changes
   through review. The release job displays the full proposed release SHA in its
   name so approval binds the intended tested commit and approved key.
5. Supply environment secret `RELEASE_POLICY_TOKEN` with read-only repository
   administration access for the environment/immutable-release policy checks.
   `GITHUB_TOKEN` generally does not provide the required administration read
   permission. Enable immutable releases through the authorized operator process.
   Missing API permissions/protection rules fail publication closed; the workflow
   does not create or weaken repository settings.
6. Complete and retain all #185 qualification evidence for the exact proposed
   release commit, including both required ARM64 desktops and disposable-VM
   interruption proof. An authorized release operator then sets the protected
   environment variable `UPDATE_RELEASE_QUALIFIED_SHA` to that full commit SHA.
   This is an explicit ship gate, not an assertion that qualification has happened.

The [GitHub environment API](https://docs.github.com/en/rest/deployments/environments)
exposes required-reviewer and deployment-branch policies. The
[immutable-release API](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository)
requires administration read access. Independently review the environment UI's
bypass setting as part of operator setup, including where an API payload omits it.

## Build, sign, and publish

Craft still prepares versions/changelogs and the release PR. Ordinary ARM64
acceptance stages an unsigned manifest alongside the installer and checksum;
it never receives a private signing key. Staging reads embedded Debian identity
rather than trusting the filename, and binds the exact installer digest to both
same-commit shipped-backend and normal packaged-renderer evidence.

Dispatch Publish release only for a merged, qualified main release commit.
The protected environment's required reviewers authorize that commit. Before the
private key enters the signing step, policy checks require independent reviewer
protection, main-only deployment and enabled immutable releases. The workflow then
downloads the same passing ARM64 workflow's assets and acceptance evidence.
Signing verifies the exact manifest bytes against installed approved trust, the
embedded package version/architecture, final length/hash, checksum, and tested
policy. App and Debian versions may differ; both advance independently under the
client's eligibility policy. No signature or installer is rewritten after signing.

The workflow creates a new draft without overwriting assets, uploads all four,
and validates the complete draft's target commit, tag/version, asset inventory,
upload state, byte lengths and GitHub SHA-256 digests against the local verified
set. It checks any existing tag's actual commit, including bounded annotated-tag
resolution. Only then does it publish. GitHub's
[immutable release behavior](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
locks the release's assets and associated tag after publication. The workflow
verifies immutability afterward too. A partial draft or uncertain API result is a
failure requiring operator inspection; no clobber/delete/repair fallback runs.

The Craft allowlist requires all four assets. Direct Craft publication from the
ordinary unsigned build artifact intentionally fails that completeness gate;
use the protected Publish release workflow for signed updates.

## Bridge retention and evidence

Retain every published bridge release's original installer, manifest and signature
so older installed keys/helper protocols can still select it. Publish a bridge
signed by an old installed key that adds the next public key to its packaged
policy before relying on signatures from that next key. Do not overwrite old
assets, move tags, or discover replacement trust from GitHub. The publication
workflow never deletes historical releases/assets. Loss of the only trusted key
may require manual bootstrap recovery.

Real tests build Debian fixture archives and exercise the actual Ed25519 signer,
strict client verifier, embedded public policy, independent Debian version,
acceptance provenance, complete/incomplete drafts, immutable/protection refusal,
wrong tags, altered installers, and old-key/protocol bridge compatibility.
Generated test keys are test-only. These checks do not establish production
environment provisioning, actual publication, or privileged ARM64 qualification.

Interrupted installation and explicit administrator evidence resolution are documented
in [the recovery runbook](updates/recovery.md).
