import childProcess from 'node:child_process';
import {createRequire, syncBuiltinESMExports} from 'node:module';
const requireElectron = createRequire(
  process.env.WATCHER_ROOT + '/packages/electron/package.json'
);
const executable = requireElectron('electron');
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command === executable) {
    args = [
      process.env.WATCHER_ENTRY,
      '--user-data-dir=' + process.env.WATCHER_DATA,
      '--remote-debugging-port=' + process.env.WATCHER_DEBUG_PORT,
    ];
  }

  const child = spawn(command, args, options);
  if (command === executable) {
    console.log(
      'WATCHER_SPAWN ' +
        JSON.stringify({pid: child.pid, connected: child.connected, args})
    );
    child.once('exit', (code, signal) =>
      console.log('WATCHER_EXIT ' + JSON.stringify({pid: child.pid, code, signal}))
    );
  }

  return child;
};

syncBuiltinESMExports();
const {develop} = await import(process.env.WATCHER_ROOT + '/scripts/development.ts');
await develop();
