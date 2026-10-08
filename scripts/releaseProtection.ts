import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

import {runIfMain} from './workspace.ts';

interface SigningEnvironment {
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
  can_admins_bypass?: boolean;
}
interface BranchPolicies {
  total_count: number;
  branch_policies: {name: string; type: string}[];
}

export function validateSigningProtection(
  environment: SigningEnvironment,
  branches: BranchPolicies,
  immutable: {enabled: boolean}
) {
  assert.equal(environment.name, 'update-signing');
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
  assert.notEqual(
    environment.can_admins_bypass,
    true,
    'Signing approval cannot allow administrator bypass'
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
    immutable.enabled,
    true,
    'Immutable releases must be enabled before publication'
  );
}

function api(path: string) {
  return JSON.parse(
    execFileSync(
      'gh',
      [
        'api',
        '-H',
        'X-GitHub-Api-Version: 2026-03-10',
        'repos/nsdeschenes/shop-things/' + path,
      ],
      {encoding: 'utf8', maxBuffer: 1048576, timeout: 30000}
    )
  );
}

await runIfMain(import.meta.url, () => {
  assert.equal(process.env.GITHUB_REPOSITORY, 'nsdeschenes/shop-things');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  validateSigningProtection(
    api('environments/update-signing'),
    api('environments/update-signing/deployment-branch-policies?per_page=100'),
    api('immutable-releases')
  );
});
