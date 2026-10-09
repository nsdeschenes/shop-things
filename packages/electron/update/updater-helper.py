#!/usr/bin/python3 -I
"""Fixed protocol-v1 install boundary. Restricted signed installation boundary."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile

ROOT_UID = 0
STATE = '/var/lib/shop-things-updater'
POLICY = '/usr/lib/shop-things/update/policy.json'
IDENTITY = '/usr/lib/shop-things/update/identity.json'
ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
VERSION = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$', re.ASCII)
DEBIAN = re.compile(r'^\d[A-Za-z0-9.+~:-]*$', re.ASCII)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def strict_json(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'Duplicate JSON field')
            value[key] = item
        return value
    return json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Invalid JSON number')))


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys), 'Unexpected fields')


def tool(args, limit=65536):
    # Pipes are spooled into protected temporary files, keeping memory bounded.
    import tempfile
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=output,
                                stderr=error, env=ENV, timeout=30, check=False)
        require(result.returncode == 0, 'System verification command failed')
        require(output.tell() <= limit and error.tell() <= limit, 'System output exceeded bound')
        output.seek(0)
        return output.read(limit)


def open_path(path, uid, protected=False):
    require(type(path) is str and path.startswith('/') and len(path) <= 4096,
            'Invalid absolute candidate path')
    parts = path.split('/')[1:]
    require(parts and all(part and part not in ('.', '..') for part in parts), 'Unsafe path')
    current = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            info = os.fstat(following)
            allowed_owner = info.st_uid in (0, ROOT_UID) if protected else info.st_uid in (0, uid)
            sticky_root = not protected and info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            if not allowed_owner or (info.st_mode & 0o022 and not sticky_root):
                os.close(following)
                raise ValueError('Unsafe containing directory')
            os.close(current)
            current = following
        file = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
        info = os.fstat(file)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1 or info.st_mode & (0o022 if protected else 0o077):
            os.close(file)
            raise ValueError('Unsafe input file')
        return file
    finally:
        os.close(current)


def protected_bytes(path, limit):
    file = open_path(path, ROOT_UID, True)
    try:
        info = os.fstat(file)
        require(0 < info.st_size <= limit, 'Protected file exceeded bounds')
        return os.read(file, limit + 1)
    finally:
        os.close(file)


def identity(raw):
    value = strict_json(raw)
    exact(value, ['schemaVersion', 'packageName', 'appVersion'])
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and
            value['packageName'] == 'shop-things' and type(value['appVersion']) is str and
            len(value['appVersion']) <= 128 and VERSION.fullmatch(value['appVersion']), 'Invalid application identity')
    return value


def installed_baseline():
    value = identity(protected_bytes(IDENTITY, 4096))
    fields = tool(['/usr/bin/dpkg-query', '--show', '--showformat=${Status}\t${Architecture}\t${Version}', 'shop-things'], 4096).decode().split('\t')
    require(len(fields) == 3 and 0 < len(fields[2]) <= 128 and fields[0] == 'install ok installed' and fields[1] == 'arm64', 'Unsupported installed package')
    require(tool(['/usr/bin/dpkg-query', '--search', '/opt/Shop Things/shop-things'], 4096).decode().strip() == 'shop-things: /opt/Shop Things/shop-things', 'Wrong executable owner')
    file = open_path('/opt/Shop Things/shop-things', ROOT_UID, True)
    os.close(file)
    return {'appVersion': value['appVersion'], 'packageVersion': fields[2], 'architecture': 'arm64'}


def sync_directory(path):
    file = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(file)
    finally:
        os.close(file)


def write_private(path, value):
    file = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(file, 'wb', closefd=False) as stream:
            stream.write(value)
            stream.flush()
            os.fsync(file)
    finally:
        os.close(file)


def package_identity(path):
    # Stream only the fixed data member. Never extract archive paths to the filesystem.
    import threading
    process = subprocess.Popen(['/usr/bin/dpkg-deb', '--fsys-tarfile', path],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=ENV)
    timer = threading.Timer(30, process.kill)
    timer.start()
    found = None
    expanded = count = 0
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
            for member in archive:
                count += 1
                expanded += member.size
                require(count <= 100000 and expanded <= 4 * 1073741824, 'Package expansion exceeded bound')
                name = member.name.removeprefix('./')
                if name in ('', '.'):
                    require(member.isdir(), 'Unsafe archive root')
                require(name in ('', '.') or (not name.startswith('/') and all(part not in ('', '.', '..') for part in name.split('/'))), 'Unsafe archive path')
                if name in ['opt', 'opt/Shop Things', 'opt/Shop Things/resources', 'opt/Shop Things/resources/update']:
                    require(member.isdir(), 'Unsafe application identity parent')
                if name == 'opt/Shop Things/resources/update/identity.json':
                    require(found is None and member.isreg() and 0 < member.size <= 4096, 'Unsafe duplicate/link application identity')
                    found = identity(archive.extractfile(member).read(4097))
        require(process.wait(timeout=30) == 0 and found is not None, 'Missing package application identity')
        return found
    finally:
        timer.cancel()
        if process.poll() is None:
            process.kill()
        process.stdout.close()
        process.wait()


def verify_request(request, uid):
    exact(request, ['protocol', 'attemptId', 'manifest', 'signature', 'candidatePath'])
    require(type(request['protocol']) is int and request['protocol'] == 1 and
            type(request['attemptId']) is str and UUID.fullmatch(request['attemptId']), 'Unknown helper protocol/attempt')
    raw = []
    for name, limit in [('manifest', 65536), ('signature', 64)]:
        value = request[name]
        require(type(value) is str and len(value) <= ((limit + 2) // 3) * 4, 'Invalid encoded bounds')
        decoded = base64.b64decode(value, validate=True)
        require(base64.b64encode(decoded).decode() == value and 0 < len(decoded) <= limit, 'Noncanonical input')
        raw.append(decoded)
    require(len(raw[1]) == 64, 'Invalid signature size')
    policy = strict_json(protected_bytes(POLICY, 65536))
    exact(policy, ['schemaVersion', 'helperProtocol', 'trustedKeys'])
    require(type(policy['schemaVersion']) is int and policy['schemaVersion'] == 1 and
            type(policy['helperProtocol']) is int and policy['helperProtocol'] == 1 and
            type(policy['trustedKeys']) is list and 0 < len(policy['trustedKeys']) <= 16, 'Invalid trust policy')
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    info = os.lstat(STATE)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == ROOT_UID and not info.st_mode & 0o077, 'Unsafe system state')
    # Validate protected state ancestors, avoiding user-owned or symlink parents.
    state_probe = str(Path(STATE) / 'probe')
    try:
        probe = open_path(state_probe, ROOT_UID, True)
        os.close(probe)
        raise ValueError('Unexpected state probe')
    except FileNotFoundError:
        pass
    attempt = str(Path(STATE) / request['attemptId'])
    os.mkdir(attempt, 0o700)  # Exclusive: an old attempt is never replayable.
    sync_directory(STATE)
    manifest_path = str(Path(attempt) / 'manifest.json')
    signature_path = str(Path(attempt) / 'manifest.sig')
    write_private(manifest_path, raw[0])
    write_private(signature_path, raw[1])
    trusted = False
    seen = set()
    for index, pem in enumerate(policy['trustedKeys']):
        require(type(pem) is str and len(pem) <= 4096 and pem.startswith('-----BEGIN PUBLIC KEY-----\n') and pem.endswith('-----END PUBLIC KEY-----\n') and pem not in seen, 'Only unique public SPKI keys are allowed')
        seen.add(pem)
        key_path = str(Path(attempt) / ('key-' + str(index) + '.pem'))
        write_private(key_path, pem.encode())
        canonical = tool(['/usr/bin/openssl', 'pkey', '-pubin', '-in', key_path, '-pubout'])
        require(canonical == pem.encode(), 'Noncanonical public key')
        der = tool(['/usr/bin/openssl', 'pkey', '-pubin', '-in', key_path, '-pubout', '-outform', 'DER'])
        require(len(der) == 44 and der[:12] == bytes.fromhex('302a300506032b6570032100'), 'Public key must be Ed25519')
        try:
            tool(['/usr/bin/openssl', 'pkeyutl', '-verify', '-rawin', '-pubin', '-inkey', key_path, '-in', manifest_path, '-sigfile', signature_path])
            trusted = True
        except ValueError:
            pass
    require(trusted, 'Signature is not trusted')
    manifest = strict_json(raw[0])
    exact(manifest, ['schemaVersion', 'applicationId', 'repository', 'channel', 'appVersion', 'packageName', 'packageVersion', 'platform', 'architecture', 'helperProtocol', 'artifact'])
    require(type(manifest['schemaVersion']) is int and manifest['schemaVersion'] == 1 and
            manifest['applicationId'] == 'com.shopthings.app' and manifest['repository'] == 'nsdeschenes/shop-things' and
            manifest['channel'] == 'stable' and manifest['packageName'] == 'shop-things' and
            manifest['platform'] == 'linux' and manifest['architecture'] == 'arm64', 'Invalid signed identity')
    version = manifest['appVersion']
    package_version = manifest['packageVersion']
    require(type(version) is str and len(version) <= 128 and VERSION.fullmatch(version), 'Invalid stable version')
    require(type(package_version) is str and len(package_version) <= 128, 'Invalid Debian version')
    remainder = package_version
    if ':' in remainder:
        epoch, remainder = remainder.split(':', 1)
        require(re.fullmatch('[0-9]+', epoch), 'Invalid Debian epoch')
    upstream, separator, revision = remainder.rpartition('-')
    require(DEBIAN.fullmatch(upstream if separator else remainder) and
            (not separator or re.fullmatch('[A-Za-z0-9.+~]+', revision)), 'Invalid Debian version')
    exact(manifest['helperProtocol'], ['min', 'max'])
    require(all(type(manifest['helperProtocol'][key]) is int and manifest['helperProtocol'][key] == 1 for key in ['min', 'max']), 'Incompatible helper')
    artifact = manifest['artifact']
    exact(artifact, ['filename', 'byteLength', 'sha256'])
    require(artifact['filename'] == 'shop-things-' + version + '-linux-arm64.deb' and
            type(artifact['byteLength']) is int and 0 < artifact['byteLength'] <= 1073741824 and
            type(artifact['sha256']) is str and re.fullmatch('[a-f0-9]{64}', artifact['sha256']), 'Invalid artifact')
    baseline = installed_baseline()
    require(tuple(map(int, version.split('+')[0].split('.'))) > tuple(map(int, baseline['appVersion'].split('+')[0].split('.'))), 'App must advance independently')
    tool(['/usr/bin/dpkg', '--compare-versions', package_version, 'gt', baseline['packageVersion']])
    source = open_path(request['candidatePath'], uid)
    staged = str(Path(attempt) / 'artifact.deb')
    try:
        before = os.fstat(source)
        require(before.st_size == artifact['byteLength'], 'Source length mismatch')
        destination = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        digest = hashlib.sha256()
        total = 0
        try:
            with os.fdopen(destination, 'wb', closefd=False) as output:
                while chunk := os.read(source, 1048576):
                    total += len(chunk)
                    require(total <= artifact['byteLength'], 'Source expanded during copy')
                    digest.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(destination)
        finally:
            os.close(destination)
        after = os.fstat(source)
        current = os.stat(request['candidatePath'], follow_symlinks=False)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                (current.st_dev, current.st_ino) == (before.st_dev, before.st_ino), 'Source replaced during copy')
        require(total == artifact['byteLength'] and digest.hexdigest() == artifact['sha256'], 'Staged bytes differ')
    finally:
        os.close(source)
    sync_directory(attempt)
    control = tool(['/usr/bin/dpkg-deb', '--field', staged, 'Package', 'Version', 'Architecture'], 8192).decode()
    require(dict(line.split(': ', 1) for line in control.strip().split('\n')) ==
            {'Package': 'shop-things', 'Version': package_version, 'Architecture': 'arm64'}, 'Embedded package mismatch')
    require(package_identity(staged)['appVersion'] == version, 'Embedded application version mismatch')
    return {'protocol': 1, 'type': 'outcome', 'attemptId': request['attemptId'], 'outcome': 'install-disabled',
            'errorCode': 'INSTALL_DISABLED', 'manifestDigest': hashlib.sha256(raw[0]).hexdigest(),
            'appVersion': version, 'packageVersion': package_version, 'baseline': baseline}


def main():
    os.umask(0o077)
    request = None
    try:
        require(len(sys.argv) == 1, 'Caller options are not supported')
        require(os.geteuid() == 0 and os.uname().sysname == 'Linux' and os.uname().machine == 'aarch64', 'Helper requires scoped ARM64 authorization')
        uid = int(os.environ.get('PKEXEC_UID', '0'))
        require(uid > 0, 'Original desktop user is required')
        raw = sys.stdin.buffer.read(100001)
        require(0 < len(raw) <= 100000, 'Request exceeded bounds')
        request = strict_json(raw)
        verified = verify_request(request, uid)
        import importlib.util
        path = '/usr/lib/shop-things/update/transaction.py'
        protected_bytes(path, 1048576)
        spec = importlib.util.spec_from_file_location('transaction', path)
        transaction = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(transaction)
        result = transaction.install(verified, uid)
    except Exception:
        # No paths, raw request, key material or arbitrary tool output in diagnostics.
        result = {'protocol': 1, 'type': 'outcome', 'outcome': 'rejected', 'errorCode': 'VERIFICATION'}
        if type(request) is dict and type(request.get('attemptId')) is str and UUID.fullmatch(request['attemptId']):
            result['attemptId'] = request['attemptId']
    print(json.dumps(result, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
