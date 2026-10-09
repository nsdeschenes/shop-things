import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {runIfMain} from './workspace.ts';

const commitPattern = /^[a-f0-9]{40}$/;

export function acceptedWorkflowRun(
  response: {
    workflow_runs: {
      id: number;
      head_sha: string;
      head_branch: string;
      event: string;
      path: string;
      status: string;
      conclusion: string;
    }[];
  },
  workflow: string,
  sha: string
) {
  assert.match(sha, commitPattern);
  assert.ok(['desktop.yml', 'scripts.yml', 'update-apt.yml'].includes(workflow));
  assert.ok(
    Array.isArray(response.workflow_runs) && response.workflow_runs.length <= 100
  );
  const run = response.workflow_runs.find(
    run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push'
  );
  assert.ok(run, 'Exact-SHA main push proof is required for ' + workflow);
  assert.equal(run.path, '.github/workflows/' + workflow);
  assert.ok(Number.isSafeInteger(run.id) && run.id > 0);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  return run;
}

await runIfMain(import.meta.url, async () => {
  assert.equal(process.env.GITHUB_REPOSITORY, 'nsdeschenes/shop-things');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  const sha = process.env.RELEASE_SHA;
  const directory = process.env.CI_EVIDENCE_DIRECTORY;
  assert.ok(sha && directory && process.env.GITHUB_OUTPUT);
  assert.equal(
    sha,
    process.env.GITHUB_SHA,
    'Accepted candidate must equal the dispatched run SHA'
  );
  await mkdir(directory, {recursive: true});
  for (const workflow of ['desktop.yml', 'scripts.yml', 'update-apt.yml']) {
    const response = JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          '--method',
          'GET',
          '-H',
          'X-GitHub-Api-Version: 2026-03-10',
          'repos/nsdeschenes/shop-things/actions/workflows/' + workflow + '/runs',
          '-f',
          'head_sha=' + sha,
          '-f',
          'branch=main',
          '-f',
          'event=push',
          '-f',
          'per_page=100',
        ],
        {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000}
      )
    );
    const run = acceptedWorkflowRun(response, workflow, sha);
    await writeFile(
      join(directory, workflow + '.json'),
      JSON.stringify(run, null, 2) + '\n',
      {flag: 'wx', mode: 0o600}
    );
    await writeFile(
      process.env.GITHUB_OUTPUT,
      (workflow === 'desktop.yml'
        ? 'run_id'
        : workflow === 'update-apt.yml'
          ? 'apt_run_id'
          : 'scripts_run_id') +
        '=' +
        run.id +
        '\n',
      {flag: 'a'}
    );
  }
});
