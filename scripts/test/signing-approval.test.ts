import {expect, test} from 'vitest';

import {validateSigningRunApproval} from '../releaseProtection.ts';

const environment = {
  id: 17,
  name: 'update-signing',
  protection_rules: [
    {
      type: 'required_reviewers',
      prevent_self_review: true,
      reviewers: [{type: 'User', reviewer: {id: 3, type: 'User'}}],
    },
  ],
  deployment_branch_policy: {protected_branches: false, custom_branch_policies: true},
};
const run = {
  id: 10,
  path: '.github/workflows/qualification-signing.yml',
  head_sha: 'a'.repeat(40),
  head_branch: 'main',
  event: 'workflow_dispatch',
  run_attempt: 1,
  actor: {id: 1},
  triggering_actor: {id: 2},
};
const approval = {
  state: 'approved',
  user: {id: 3, type: 'User'},
  environments: [{id: 17, name: 'update-signing'}],
};
test('supported independent approval binds the first main signing run to exact candidate SHA', () => {
  expect(
    validateSigningRunApproval(environment, run, [approval], {
      runId: '10',
      sha: 'a'.repeat(40),
      candidateSha: 'a'.repeat(40),
      attempt: '1',
    })
  ).toMatchObject({
    environmentId: 17,
    reviewerId: 3,
    administratorBypassVerification: 'unobservable',
  });
});
test('missing, self, Team, rejected, rerun and mismatched SHA approval fail closed', () => {
  const context = {
    runId: '10',
    sha: 'a'.repeat(40),
    candidateSha: 'a'.repeat(40),
    attempt: '1',
  };
  for (const approvals of [
    [],
    [{...approval, user: {id: 1, type: 'User'}}],
    [{...approval, user: {id: 3, type: 'Bot'}}],
    [approval, {...approval, state: 'rejected'}],
    [{...approval, environments: [{id: 18, name: 'update-signing'}]}],
  ]) {
    expect(() =>
      validateSigningRunApproval(environment, run, approvals, context)
    ).toThrow();
  }

  expect(() =>
    validateSigningRunApproval(environment, {...run, run_attempt: 2}, [approval], context)
  ).toThrow();
  expect(() =>
    validateSigningRunApproval(environment, run, [approval], {
      ...context,
      candidateSha: 'b'.repeat(40),
    })
  ).toThrow();
  expect(() =>
    validateSigningRunApproval(
      {
        ...environment,
        protection_rules: [
          {
            type: 'required_reviewers',
            prevent_self_review: true,
            reviewers: [{type: 'Team', reviewer: {id: 3, type: 'User'}}],
          },
        ],
      },
      run,
      [approval],
      context
    )
  ).toThrow();
});
