import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';

import {runIfMain} from './workspace.ts';

const commitPattern = /^[a-f0-9]{40}$/;

interface SigningEnvironment {
  id: number;
  name: string;
  protection_rules: {
    type: string;
    prevent_self_review?: boolean;
    reviewers?: unknown[];
  }[];
  deployment_branch_policy: {
    protected_branches: boolean;
    custom_branch_policies: boolean;
  } | null;
}
interface BranchPolicies {
  total_count: number;
  branch_policies: {name: string; type: string}[];
}

export function validateSigningProtection(
  environment: SigningEnvironment,
  branches: BranchPolicies,
  immutable: {enabled: boolean; enforced_by_owner: boolean}
) {
  allowedReviewers(environment);
  assert.ok(
    environment.protection_rules.some(
      rule =>
        rule.type === 'required_reviewers' &&
        rule.prevent_self_review === true &&
        rule.reviewers &&
        rule.reviewers.length > 0
    ),
    'Independent required reviewer approval must protect signing'
  );
  assert.deepEqual(
    environment.deployment_branch_policy,
    {protected_branches: false, custom_branch_policies: true},
    'Signing must use an explicit main-only deployment policy'
  );
  assert.equal(branches.total_count, 1);
  assert.deepEqual(
    branches.branch_policies,
    [{name: 'main', type: 'branch'}],
    'Only the main branch may enter signing'
  );
  assert.equal(
    typeof immutable.enforced_by_owner,
    'boolean',
    'Owner enforcement must be observable'
  );
  assert.equal(
    immutable.enabled,
    true,
    'Immutable releases must be enabled before publication'
  );
}

function positiveId(value: unknown): number {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function allowedReviewers(environment: SigningEnvironment) {
  positiveId(environment.id);
  assert.equal(environment.name, 'update-signing');
  const rules = environment.protection_rules.filter(
    rule => rule.type === 'required_reviewers'
  );
  assert.equal(rules.length, 1, 'One unambiguous native reviewer rule required');
  const rule = rules[0];
  assert.ok(
    rule &&
      rule.prevent_self_review === true &&
      rule.reviewers?.length &&
      rule.reviewers.length <= 6
  );
  const ids = rule.reviewers.map(value => {
    const reviewer = record(value);
    assert.equal(
      reviewer.type,
      'User',
      'Only explicitly configured human User reviewers are supported'
    );
    const user = record(reviewer.reviewer);
    assert.equal(user.type, 'User', 'Configured reviewer must be a human User');
    return positiveId(user.id);
  });
  assert.equal(new Set(ids).size, ids.length);
  return ids;
}

export function validateSigningRunApproval(
  environment: SigningEnvironment,
  value: unknown,
  history: unknown,
  context: {runId: string; sha: string; candidateSha: string; attempt: string}
) {
  const allowed = allowedReviewers(environment);
  const run = record(value);
  assert.match(context.candidateSha, commitPattern);
  assert.equal(
    context.candidateSha,
    context.sha,
    'Candidate checkout must equal the dispatched approval SHA'
  );
  assert.equal(String(positiveId(run.id)), context.runId);
  assert.equal(run.head_sha, context.sha);
  assert.ok(
    [
      '.github/workflows/publish-release.yml',
      '.github/workflows/qualification-signing.yml',
    ].includes(String(run.path)),
    'Only the reviewed single-environment signing workflows are supported'
  );
  assert.equal(run.head_branch, 'main');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(
    run.run_attempt,
    1,
    'Run-scoped approval history cannot prove rerun approval'
  );
  assert.equal(context.attempt, '1');
  const actor = positiveId(record(run.actor).id);
  const triggering = positiveId(record(run.triggering_actor).id);
  assert.ok(Array.isArray(history) && history.length > 0 && history.length <= 64);
  const matching: number[] = [];
  for (const value of history) {
    const item = record(value);
    assert.ok(
      Array.isArray(item.environments) &&
        item.environments.length > 0 &&
        item.environments.length <= 16
    );
    const relevant = item.environments.some(value => {
      const target = record(value);
      positiveId(target.id);
      if (target.id === environment.id || target.name === environment.name) {
        assert.equal(target.id, environment.id);
        assert.equal(target.name, environment.name);
        return true;
      }

      return false;
    });
    if (!relevant) {
      continue;
    }

    assert.equal(
      item.state,
      'approved',
      'Pending/rejected or ambiguous environment history denies signing'
    );
    const user = record(item.user);
    assert.equal(user.type, 'User');
    const id = positiveId(user.id);
    assert.ok(
      allowed.includes(id) && id !== actor && id !== triggering,
      'Observed approval must be independent and allowlisted'
    );
    matching.push(id);
  }

  assert.equal(matching.length, 1, 'One unambiguous independent approval is required');
  return {
    schemaVersion: 1,
    runId: run.id,
    testedSha: context.sha,
    environmentId: environment.id,
    reviewerId: matching[0],
    actorId: actor,
    triggeringActorId: triggering,
    administratorBypassVerification: 'unobservable',
  };
}

function api(path: string) {
  return JSON.parse(
    execFileSync(
      'gh',
      [
        'api',
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2026-03-10',
        'repos/nsdeschenes/shop-things/' + path,
      ],
      {encoding: 'utf8', maxBuffer: 1048576, timeout: 30000}
    )
  );
}

await runIfMain(import.meta.url, async () => {
  assert.equal(process.env.GITHUB_REPOSITORY, 'nsdeschenes/shop-things');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  const environment = api('environments/update-signing');
  validateSigningProtection(
    environment,
    api('environments/update-signing/deployment-branch-policies?per_page=100'),
    api('immutable-releases')
  );
  assert.ok(
    process.env.GITHUB_RUN_ID &&
      process.env.GITHUB_SHA &&
      process.env.RELEASE_SHA &&
      process.env.GITHUB_RUN_ATTEMPT
  );
  const proof = validateSigningRunApproval(
    environment,
    api('actions/runs/' + process.env.GITHUB_RUN_ID),
    api('actions/runs/' + process.env.GITHUB_RUN_ID + '/approvals'),
    {
      runId: process.env.GITHUB_RUN_ID,
      sha: process.env.GITHUB_SHA,
      candidateSha: process.env.RELEASE_SHA,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
    }
  );
  if (process.env.SIGNING_PROTECTION_REPORT_PATH) {
    await writeFile(
      process.env.SIGNING_PROTECTION_REPORT_PATH,
      JSON.stringify(proof, null, 2) + '\n',
      {flag: 'wx', mode: 0o600}
    );
  }
});
