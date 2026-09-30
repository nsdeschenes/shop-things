const {realpathSync} = require('node:fs');
const {app} = require('electron');

// Test-owned entry verifies the standard flag before any production code can run.
const expected = realpathSync(process.env.SHOP_THINGS_ISOLATION_EXPECTED);
const actual = app.getPath('userData');
if (actual !== expected) {
  app.setPath('userData', expected);
  console.error(JSON.stringify({stage: 'before-ready', expected, actual}));
  app.exit(2);
} else {
  void app.whenReady().then(() => {
    console.log(
      JSON.stringify({
        beforeReady: actual,
        ready: app.getPath('userData'),
        electron: process.versions.electron,
        expected,
      })
    );
    app.exit(app.getPath('userData') === expected ? 0 : 3);
  });
}
