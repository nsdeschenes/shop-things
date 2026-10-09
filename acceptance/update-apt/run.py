"""Disposable real ARM64 APT proof. No host mounts or privileged-host mode."""
import base64
import hashlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
from threading import Thread
import uuid

case = sys.argv[1]
assert os.geteuid() == 0 and os.uname().machine == 'aarch64'
os.umask(0o022)

def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout

def package(name, version, extra='', script=''):
    root = Path('/fixture/build/' + name + version)
    (root / 'DEBIAN').mkdir(parents=True)
    (root / 'DEBIAN/control').write_text('Package: ' + name + '\nVersion: ' + version + '\nArchitecture: arm64\nMaintainer: Fixture <noreply@example.com>\nDescription: harmless disposable fixture\n' + extra)
    if script:
        (root / 'DEBIAN/postinst').write_text('#!/bin/sh\nset -e\necho ' + name + ' >> /fixture/mutations\n' + script + '\n')
        (root / 'DEBIAN/postinst').chmod(0o755)
    if name == 'shop-things':
        payload = root / 'opt/Shop Things'
        (payload / 'resources/update').mkdir(parents=True)
        (payload / 'shop-things').write_text('#!/bin/sh\nexit 0\n')
        (payload / 'shop-things').chmod(0o755)
        (payload / 'resources/update/identity.json').write_text(json.dumps({'schemaVersion': 1, 'packageName': name, 'appVersion': version}))
    else:
        (root / 'usr/share/fixture').mkdir(parents=True)
        (root / ('usr/share/fixture/' + name)).write_text(name)
    destination = Path('/fixture/repo/' + name + '_' + version + '_arm64.deb')
    run('/usr/bin/dpkg-deb', '--build', '--root-owner-group', str(root), str(destination))
    return destination

Path('/fixture/repo').mkdir()
run('/usr/sbin/useradd', '-m', 'fixture')
caller = pwd.getpwnam('fixture')
assert caller.pw_uid > 0
base = package('shop-things', '1.0.0')
victim = package('victim', '1.0.0')
run('/usr/bin/dpkg', '-i', str(base), str(victim))
extra = 'Breaks: victim\n' if case == 'breaks' else 'Replaces: victim\n' if case == 'replaces' else ''
dep = package('fixture-dep', '1.0.0', extra, 'exit 1' if case == 'partial' else 'true')
run('/usr/bin/gpg', '--batch', '--passphrase', '', '--quick-gen-key', 'Disposable fixture <noreply@example.com>', 'rsa2048', 'sign', '0')
key = run('/usr/bin/gpg', '--export')
Path('/usr/share/keyrings/fixture.gpg').write_bytes(key)
Path('/fixture/repo/Packages').write_bytes(run('/usr/bin/apt-ftparchive', 'packages', '.', cwd='/fixture/repo'))
Path('/fixture/repo/Release').write_bytes(run('/usr/bin/apt-ftparchive', 'release', '.', cwd='/fixture/repo'))
run('/usr/bin/gpg', '--batch', '--yes', '--clearsign', '-o', '/fixture/repo/InRelease', '/fixture/repo/Release')
# Only dependencies come from the repository; the signed app stays a local input.
target = package('shop-things', '2.0.0', 'Depends: fixture-dep (= 1.0.0)\n', "cp '/opt/Shop Things/resources/update/identity.json' /usr/lib/shop-things/update/identity.json")
# file: permits direct repository paths instead of the protected APT archive cache.
repository = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory='/fixture/repo'))
Thread(target=repository.serve_forever, daemon=True).start()
repository_url = 'http://127.0.0.1:' + str(repository.server_port)
for source in Path('/etc/apt/sources.list.d').iterdir():
    source.unlink()
Path('/etc/apt/sources.list').unlink(missing_ok=True)
Path('/etc/apt/sources.list.d/fixture.list').write_text('deb [signed-by=/usr/share/keyrings/fixture.gpg' + (' trusted=yes' if case == 'trusted' else '') + '] ' + repository_url + ' ./\n')
run('/usr/bin/apt-get', 'update')
Path('/usr/lib/shop-things/update').mkdir(parents=True)
for name, destination, mode in [('updater-helper.py', '/usr/lib/shop-things/updater-helper', 0o755),
                              ('transaction.py', '/usr/lib/shop-things/update/transaction.py', 0o644),
                              ('apt-hook', '/usr/lib/shop-things/update/apt-hook', 0o755)]:
    shutil.copyfile('/fixture/code/' + name, destination)
    Path(destination).chmod(mode)
Path('/usr/lib/shop-things/update/identity.json').write_text(json.dumps({'schemaVersion': 1, 'packageName': 'shop-things', 'appVersion': '1.0.0'}))
run('/usr/bin/openssl', 'genpkey', '-algorithm', 'ED25519', '-out', '/fixture/private.pem')
pem = run('/usr/bin/openssl', 'pkey', '-in', '/fixture/private.pem', '-pubout').decode()
Path('/usr/lib/shop-things/update/policy.json').write_text(json.dumps({'schemaVersion': 1, 'helperProtocol': 1, 'trustedKeys': [pem]}))
spec = importlib.util.spec_from_file_location('transaction', '/usr/lib/shop-things/update/transaction.py')
transaction = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transaction)
transaction.initialize()
if case == 'held':
    run('/usr/bin/apt-mark', 'hold', 'shop-things')
if case == 'dirty':
    Path('/var/lib/dpkg/updates/9999').write_text('unfinished')
installer = Path(caller.pw_dir) / 'candidate.deb'
installer.write_bytes(target.read_bytes())
os.chown(installer, caller.pw_uid, caller.pw_gid)
installer.chmod(0o600)
raw = installer.read_bytes()
manifest = {'schemaVersion': 1, 'applicationId': 'com.shopthings.app', 'repository': 'nsdeschenes/shop-things',
            'channel': 'stable', 'appVersion': '2.0.0', 'packageName': 'shop-things', 'packageVersion': '2.0.0',
            'platform': 'linux', 'architecture': 'arm64', 'helperProtocol': {'min': 1, 'max': 1},
            'artifact': {'filename': 'shop-things-2.0.0-linux-arm64.deb', 'byteLength': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}}
Path('/fixture/manifest').write_bytes(json.dumps(manifest).encode())
run('/usr/bin/openssl', 'pkeyutl', '-sign', '-rawin', '-inkey', '/fixture/private.pem', '-in', '/fixture/manifest', '-out', '/fixture/signature')
request = {'protocol': 1, 'attemptId': str(uuid.uuid4()), 'manifest': base64.b64encode(Path('/fixture/manifest').read_bytes()).decode(),
           'signature': base64.b64encode(Path('/fixture/signature').read_bytes()).decode(), 'candidatePath': str(installer)}
before = run('/usr/bin/dpkg-query', '-W', '-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Abbrev}\n') if case != 'dirty' else None
lock = None
if case == 'lock':
    import fcntl
    lock = os.open('/var/lib/dpkg/lock-frontend', os.O_WRONLY)
    fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
process = subprocess.run(['/usr/bin/python3', '-I', '/usr/lib/shop-things/updater-helper'], input=json.dumps(request).encode(),
                         capture_output=True, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'PKEXEC_UID': str(caller.pw_uid)}, timeout=120)
if lock:
    os.close(lock)
assert process.returncode == 0, process.stderr
outcome = json.loads(process.stdout)
print(json.dumps({'case': case, 'outcome': outcome, 'aptVersion': run('/usr/bin/apt-get', '--version').decode().splitlines()[0],
                  'pythonAptVersion': run('/usr/bin/python3', '-I', '-c', 'import apt_pkg; print(apt_pkg.VERSION)').decode().strip()}))
journal_path = Path('/var/lib/shop-things-updater/' + request['attemptId'] + '/journal.json')
if journal_path.exists():
    journal = json.loads(journal_path.read_text())
    print(json.dumps({'journal': journal, 'global': transaction.global_index()}))
if case == 'allowed':
    assert outcome['outcome'] == 'installed', outcome
    evidence = transaction.inspect(caller.pw_uid, request['attemptId'])
    assert evidence['outcome'] == 'installed', evidence
    names = [row['package'] for batch in journal['plan'] for row in batch if row['action'].startswith('/')]
    assert set(names) == {'shop-things', 'fixture-dep'}, names
    assert Path('/fixture/mutations').read_text().splitlines() == ['fixture-dep', 'shop-things']
    # Another UID sees no private package inventory, but root index is readable.
    run('/usr/sbin/useradd', '-m', 'other')
    blocked = subprocess.run(['/usr/sbin/runuser', '-u', 'other', '--', '/usr/bin/cat', '/var/lib/shop-things-updater-receipts/users/' + str(caller.pw_uid) + '/' + request['attemptId'] + '.json'], capture_output=True)
    assert blocked.returncode != 0
elif case == 'partial':
    assert outcome['outcome'] == 'uncertain', outcome
    assert transaction.global_index()['unresolved']
    assert Path('/fixture/mutations').exists()
    assert journal['phase'] == 'recovery'
else:
    assert outcome['outcome'] in ('rejected', 'unchanged'), outcome
    assert not Path('/fixture/mutations').exists()
    if before is not None:
        assert run('/usr/bin/dpkg-query', '-W', '-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Abbrev}\n') == before
print('PASS ' + case)
