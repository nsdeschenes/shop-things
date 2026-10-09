import {execFile} from 'node:child_process';
import {realpath} from 'node:fs/promises';
import {promisify} from 'node:util';

import {supervisorPath} from './restartSupervisor.js';
import {
  protectedSystemFile,
  updateHelperPath,
  updateIdentityPath,
} from './updateHelperProtocol.js';
import {stableVersion} from './updateManifest.js';
import {loadInstalledUpdatePolicy} from './updatePolicy.js';

const execute = promisify(execFile);
export async function inspectUpdateCapabilities(options: {
  packaged: boolean;
  appVersion: string;
}) {
  const reasons: string[] = [];
  let trustedKeys: string[] = [];
  let packageVersion = options.appVersion;
  let packageIdentityAvailable = false;
  if (
    !options.packaged ||
    process.platform !== 'linux' ||
    process.arch !== 'arm64' ||
    process.getuid?.() === 0
  ) {
    return {
      trustedKeys,
      packageVersion,
      packageIdentityAvailable,
      reasons: ['Updates require an original-user Linux ARM64 system installation.'],
    };
  }

  try {
    trustedKeys = (await loadInstalledUpdatePolicy()).trustedKeys;
    const identity = JSON.parse(
      (await protectedSystemFile(updateIdentityPath, 4096)).toString('utf8')
    );
    if (
      Object.keys(identity).sort().join(',') !== 'appVersion,packageName,schemaVersion' ||
      identity.schemaVersion !== 1 ||
      identity.packageName !== 'shop-things' ||
      typeof identity.appVersion !== 'string' ||
      !stableVersion.test(identity.appVersion) ||
      identity.appVersion !== options.appVersion
    ) {
      throw new Error('Installed application identity mismatch.');
    }

    const result = await execute(
      '/usr/bin/dpkg-query',
      ['--show', '--showformat=${Status}\t${Architecture}\t${Version}', 'shop-things'],
      {timeout: 30000, maxBuffer: 4096, env: {PATH: '/usr/bin:/bin', LC_ALL: 'C'}}
    );
    const fields = result.stdout.split('\t');
    if (
      fields.length !== 3 ||
      fields[0] !== 'install ok installed' ||
      fields[1] !== 'arm64' ||
      !fields[2]
    ) {
      throw new Error('Unsupported package identity.');
    }

    packageVersion = fields[2];
    const owner = await execute(
      '/usr/bin/dpkg-query',
      ['--search', '/opt/Shop Things/shop-things'],
      {timeout: 30000, maxBuffer: 4096}
    );
    if (owner.stdout.trim() !== 'shop-things: /opt/Shop Things/shop-things') {
      throw new Error('Wrong package executable owner.');
    }

    await protectedSystemFile('/opt/Shop Things/shop-things', 1073741824, false);
    packageIdentityAvailable = true;
  } catch {
    reasons.push(
      'Installed publisher trust or configured package identity is unavailable.'
    );
  }

  try {
    for (const path of [
      updateHelperPath,
      '/usr/lib/shop-things/update/apt-hook',
      supervisorPath,
      '/usr/bin/apt-get',
      '/usr/bin/dpkg',
      '/usr/bin/dpkg-deb',
      '/usr/bin/pkexec',
      '/usr/bin/openssl',
      '/usr/bin/setfacl',
      '/usr/bin/getfacl',
      '/usr/bin/pkaction',
      await realpath('/usr/bin/python3'),
    ]) {
      await protectedSystemFile(path, 104857600, false);
    }

    await protectedSystemFile('/usr/lib/shop-things/update/transaction.py', 1048576);
    await protectedSystemFile('/var/lib/shop-things-updater-receipts/global.json', 65536);
    await execute(
      '/usr/bin/python3',
      [
        '-I',
        '-c',
        'import apt_pkg,os,stat; p=os.path.realpath(apt_pkg.__file__); s=os.stat(p); assert s.st_uid==0 and not s.st_mode & 0o022; assert apt_pkg.VERSION',
      ],
      {timeout: 30000, maxBuffer: 4096, env: {PATH: '/usr/bin:/bin', LC_ALL: 'C'}}
    );
    const helper = (await protectedSystemFile(updateHelperPath, 1048576)).toString(
      'utf8'
    );
    if (
      !helper.startsWith('#!/usr/bin/python3 -I\n') ||
      !helper.includes('Fixed protocol-v1 install boundary.')
    ) {
      throw new Error('Unsupported installed helper protocol.');
    }

    const action = (
      await protectedSystemFile(
        '/usr/share/polkit-1/actions/com.shopthings.app.update.policy',
        16384
      )
    ).toString('utf8');
    if (
      !action.includes('<action id="com.shopthings.app.update">') ||
      !action.includes('<allow_any>no</allow_any>') ||
      !action.includes('<allow_inactive>no</allow_inactive>') ||
      !action.includes('<allow_active>auth_admin</allow_active>') ||
      !action.includes(
        '<annotate key="org.freedesktop.policykit.exec.path">/usr/lib/shop-things/updater-helper</annotate>'
      ) ||
      action.includes('_keep')
    ) {
      throw new Error('Unsupported authentication policy.');
    }

    const registered = await execute(
      '/usr/bin/pkaction',
      ['--action-id', 'com.shopthings.app.update'],
      {
        timeout: 30000,
        maxBuffer: 16384,
        env: {PATH: '/usr/bin:/bin', LC_ALL: 'C'},
      }
    );
    if (registered.stdout.trim() !== 'com.shopthings.app.update') {
      throw new Error('The scoped action is not registered.');
    }
  } catch {
    reasons.push(
      'Protected helper, scoped authentication policy, or system tools are unavailable.'
    );
  }

  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    reasons.push('A graphical desktop authentication session is required.');
  } else {
    try {
      await execute(
        '/usr/bin/python3',
        [
          '-I',
          '-c',
          "import sys; assert sys.version_info >= (3, 9); import gi; gi.require_version('Gtk', '3.0'); from gi.repository import Gtk; assert Gtk.init_check()[0]",
        ],
        {
          timeout: 30000,
          maxBuffer: 4096,
          env: {...process.env, PYTHONPATH: '', PYTHONHOME: ''},
        }
      );
    } catch {
      reasons.push('The GTK3 restart recovery desktop is unavailable.');
    }
  }

  // Agent registration cannot be proven by portable read-only polkit APIs. Explicit
  // pkexec performs runtime authorization with its textual fallback disabled.
  return {trustedKeys, packageVersion, packageIdentityAvailable, reasons};
}
