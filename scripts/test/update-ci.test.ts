import {expect, test} from 'vitest';

import {acceptedWorkflowRun} from '../verify-update-ci.ts';

test('requires passing actual APT evidence at exact main push SHA', () => {
  const run = {
    id: 1,
    head_sha: 'a'.repeat(40),
    head_branch: 'main',
    event: 'push',
    path: '.github/workflows/update-apt.yml',
    status: 'completed',
    conclusion: 'success',
  };
  expect(
    acceptedWorkflowRun({workflow_runs: [run]}, 'update-apt.yml', 'a'.repeat(40))
  ).toBe(run);
  for (const unsafe of [
    {...run, head_sha: 'b'.repeat(40)},
    {...run, event: 'pull_request'},
    {...run, conclusion: 'failure'},
    {...run, status: 'in_progress'},
    {...run, path: '.github/workflows/desktop.yml'},
  ]) {
    expect(() =>
      acceptedWorkflowRun({workflow_runs: [unsafe]}, 'update-apt.yml', 'a'.repeat(40))
    ).toThrow();
  }
});
