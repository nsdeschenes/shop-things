const {chmod, lstat, readdir} = require('node:fs/promises');
const {join} = require('node:path');

// Normalize only the generated Linux bundle before FPM records its permissions.
// Checkout/build umask can otherwise leave root-installed resources group writable.
module.exports = async context => {
  if (context.electronPlatformName !== 'linux') {
    return;
  }

  const owner = process.getuid();
  async function normalize(path) {
    const info = await lstat(path);
    if (
      info.uid !== owner ||
      (!info.isDirectory() && !info.isFile()) ||
      (info.isFile() && info.nlink !== 1)
    ) {
      throw new Error('Unsafe packaging output');
    }

    if (info.isDirectory()) {
      for (const name of await readdir(path)) {
        await normalize(join(path, name));
      }

      await chmod(path, 0o755);
    } else {
      await chmod(path, info.mode & 0o111 ? 0o755 : 0o644);
    }
  }

  await normalize(context.appOutDir);
};
