"""External disposable fixture only; never invoked by the packaged application."""
import hashlib
import json
import pwd
from pathlib import Path
import subprocess
import sys

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def verify(expected_exit=0):
    result = subprocess.run(['/usr/local/bin/node', '--experimental-strip-types', '/fixtures/scripts/verify-bootstrap.ts'], capture_output=True, text=True)
    assert result.returncode == expected_exit, f'Bootstrap verifier exit {result.returncode}: {result.stderr[:4096]} {result.stdout[:4096]}'
    value = json.loads(result.stdout)
    return value

def inventory():
    return run('/usr/bin/dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${Architecture}\t${Status}\n')

caller = pwd.getpwnam('fixture')
assert caller.pw_uid != 0
caller_owner = f'{caller.pw_uid}:{caller.pw_gid}'

def protected_data():
    root = Path('/home/fixture/.config/electron')
    root.mkdir(parents=True)
    # Container proof covers byte/owner preservation before any application migration.
    values = {'database.json': '{"path":"/home/fixture/working.sqlite"}', 'migration-backups/retained.sqlite': 'fixture retained committed backup', 'updates/retained.json': '{"diagnostic":"retained"}'}
    for relative, content in values.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        run('/usr/bin/chown', caller_owner, str(path))
    run('/usr/bin/chown', '-R', caller_owner, str(root))
    database = Path('/home/fixture/working.sqlite')
    database.write_bytes(b'container ownership/retention sentinel; native database proof runs separately')
    run('/usr/bin/chown', caller_owner, str(database))
    return [root / name for name in values] + [database]

def fingerprints(paths):
    return {str(path): {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'uid': path.stat().st_uid, 'gid': path.stat().st_gid} for path in paths}

def install(path):
    run('/usr/bin/apt-get', '-y', '--no-remove', 'install', path)

case = sys.argv[1]
report = {'case': case, 'caller': {'uid': caller.pw_uid, 'gid': caller.pw_gid}, 'architecture': run('/usr/bin/dpkg', '--print-architecture').strip(), 'os': Path('/etc/os-release').read_text(), 'apt': run('/usr/bin/apt-get', '--version').splitlines()[0], 'dpkg': run('/usr/bin/dpkg', '--version').splitlines()[0]}
assert report['architecture'] == 'arm64'
paths = protected_data()
before = fingerprints(paths)
if case == 'fresh':
    assert verify()['kind'] == 'fresh'
elif case == 'legacy':
    install('/fixtures/legacy.deb')
    result = verify()
    assert result['kind'] == 'verified-legacy', result
    # This is an external controlled package fixture. Real UI guarded Quit is proved
    # separately on these exact archive bytes by run.mjs; no fabricated consent flag.
    run('/usr/bin/dpkg', '--remove', 'electron')
    assert not Path('/opt/Shop Things/shop-things').exists()
    assert not Path('/etc/apparmor.d/shop-things').exists()
    assert fingerprints(paths) == before
elif case == 'unrelated':
    root = Path('/fixtures/unrelated/DEBIAN')
    root.mkdir(parents=True)
    (root/'control').write_text('Package: electron\nVersion: 9\nArchitecture: arm64\nMaintainer: Unrelated fixture\nDescription: Unrelated application\n')
    marker = root.parent / 'opt/unrelated/retained'
    marker.parent.mkdir(parents=True)
    marker.write_text('unrelated package must remain')
    run('/usr/bin/dpkg-deb', '--build', '--root-owner-group', str(root.parent), '/fixtures/unrelated.deb')
    install('/fixtures/unrelated.deb')
    assert verify(1)['kind'] == 'unrelated-electron'
    unrelated_before = Path('/opt/unrelated/retained').read_bytes()
else:
    raise ValueError('Unknown controlled bootstrap case')
install('/fixtures/candidate.deb')
result = verify()
assert result['kind'] == 'verified-bootstrap', result
assert fingerprints(paths) == before
assert run('/usr/bin/dpkg-query', '-W', '-f=${Conflicts}|${Replaces}', 'shop-things') == '|'
assert run('/usr/bin/dpkg-query', '-S', '/opt/Shop Things/shop-things').strip() == 'shop-things: /opt/Shop Things/shop-things'
assert Path('/usr/bin/shop-things').resolve() == Path('/opt/Shop Things/shop-things')
if case == 'unrelated':
    assert run('/usr/bin/dpkg-query', '-W', '-f=${Status}', 'electron') == 'install ok installed'
    assert Path('/opt/unrelated/retained').read_bytes() == unrelated_before
report.update({'status': 'passed', 'verification': result, 'retained': before, 'installed': inventory(), 'alternative': run('/usr/bin/update-alternatives', '--query', 'shop-things'), 'apparmorProfilePresent': Path('/etc/apparmor.d/shop-things').exists(), 'limits': ['Container retention sentinels are not native database proof.', 'No graphical authentication or VM power-loss proof.']})
Path('/report').mkdir()
Path('/report/result.json').write_text(json.dumps(report, indent=2))
