import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';

import {expect, test} from 'vitest';

import {withBuildFixture} from './buildFixture.ts';

const forbiddenPreloadImport = /Backend code entered the preload bundle/;
const prohibitedDependency = /Prohibited contract dependency/;

test('direct Electron builds compile their contract and database prerequisites', async ({
  signal,
}) => {
  await withBuildFixture(
    'prerequisite-build',
    async fixture => {
      for (const name of ['contract', 'db', 'electron']) {
        await rm(fixture.path(`packages/${name}/dist`), {recursive: true, force: true});
      }

      await fixture.pnpm(['--filter', 'electron', 'build:main']);
      await expect(
        readFile(fixture.path('packages/contract/dist/client.js'))
      ).resolves.toBeDefined();
      await readFile(fixture.path('packages/electron/dist/main.js'));
      await readFile(fixture.path('packages/electron/dist/preload.cjs'));
      await readFile(fixture.path('packages/db/dist/index.d.ts'));
    },
    {signal}
  );
});

test('identical preload builds retain byte-identical shipped artifacts', async ({
  signal,
}) => {
  await withBuildFixture(
    'identical-preload',
    async fixture => {
      await fixture.pnpm(['--filter', 'electron', 'build:main']);
      const outputs = ['preload.cjs', 'preload.meta.json'];
      const original = await Promise.all(
        outputs.map(name => readFile(fixture.path(`packages/electron/dist/${name}`)))
      );
      for (let attempt = 0; attempt < 10; attempt++) {
        await fixture.nodeFile('packages/electron/scripts/buildPreload.mjs', [], {
          cwd: 'packages/electron',
        });
        for (const [index, name] of outputs.entries()) {
          expect(
            await readFile(fixture.path(`packages/electron/dist/${name}`))
          ).toStrictEqual(original[index]);
        }
      }
    },
    {signal}
  );
});

test('failed real preload emission leaves no launchable build', async ({signal}) => {
  await withBuildFixture(
    'failed-preload',
    async fixture => {
      await fixture.pnpm(['--filter', 'electron', 'build:main']);
      await readFile(fixture.path('packages/electron/dist/preload.cjs'));
      const preload = fixture.path('packages/electron/src/preload.ts');
      await writeFile(
        preload,
        Buffer.concat([await readFile(preload), Buffer.from('\nimport "node:fs";\n')])
      );
      await expect(fixture.pnpm(['--filter', 'electron', 'build:main'])).rejects.toThrow(
        forbiddenPreloadImport
      );
      for (const output of ['preload.cjs', 'preload.meta.json']) {
        await expect(
          readFile(fixture.path(`packages/electron/dist/${output}`))
        ).rejects.toMatchObject({code: 'ENOENT'});
      }
    },
    {signal}
  );
});

test('dependency inspection rejects backend imports in the browser contract', async ({
  signal,
}) => {
  await withBuildFixture(
    'browser-dependencies',
    async fixture => {
      await fixture.pnpm(['--filter', '@shop-things/contract', 'build']);
      await mkdir(fixture.path('packages/electron/dist'), {recursive: true});
      await fixture.nodeFile('packages/electron/scripts/buildPreload.mjs', [], {
        cwd: 'packages/electron',
      });
      await fixture.nodeFile('scripts/test/inspectBuildFixture.ts');
      const manifestPath = fixture.path('packages/contract/package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.dependencies['@shop-things/db'] = 'workspace:*';
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(
        fixture.nodeFile('scripts/test/inspectBuildFixture.ts')
      ).rejects.toThrow(prohibitedDependency);
    },
    {signal}
  );
});
