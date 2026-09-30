import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 30000,
  outputDir: '../acceptance-reports/renderer',
  reporter: [
    ['list'],
    ['json', {outputFile: 'acceptance-reports/renderer/results.json'}],
  ],
  use: {baseURL: 'http://127.0.0.1:5179', trace: 'retain-on-failure'},
  webServer: {
    command: 'node acceptance/serve.mjs',
    url: 'http://127.0.0.1:5179',
    cwd: '..',
    reuseExistingServer: false,
  },
});
