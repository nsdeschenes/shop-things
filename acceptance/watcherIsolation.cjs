const {app} = require('electron');
const expected = require('node:fs').realpathSync(process.env.SHOP_THINGS_EXPECTED_DATA);
const actual = app.getPath('userData');
console.log(
  JSON.stringify({stage: 'before-ready', expected, actual, matches: actual === expected})
);
if (actual !== expected) {
  app.setPath('userData', expected);
  app.exit(2);
} else {
  void app.whenReady().then(() => {
    console.log(
      JSON.stringify({
        stage: 'ready',
        actual: app.getPath('userData'),
        matches: app.getPath('userData') === expected,
      })
    );
    app.exit(app.getPath('userData') === expected ? 0 : 3);
  });
}
