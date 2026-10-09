import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

import {qualifyUpdate} from './updateQualification.ts';

const [root, input, output] = process.argv.slice(2);
assert.ok(
  root && input && output,
  'Usage: qualify-update.ts <evidence-root> <input-relative-path> <new-output-path>'
);
const report = await qualifyUpdate(resolve(root), input);
await writeFile(output, JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
process.stdout.write(report.status + '\n');
