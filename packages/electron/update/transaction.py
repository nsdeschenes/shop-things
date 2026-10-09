"""Protected real APT transaction, journal and original-user receipt projection."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import tempfile

STATE = '/var/lib/shop-things-updater'
RECEIPTS = '/var/lib/shop-things-updater-receipts'
HOOK = '/usr/lib/shop-things/update/apt-hook'
ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'LANG': 'C', 'DEBIAN_FRONTEND': 'noninteractive'}
MAXIMUM = 8 * 1024 * 1024
PACKAGE = re.compile(r'^[a-z0-9][a-z0-9+.-]{0,127}(?::[a-z0-9-]{1,32})?$')
VERSION = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$', re.ASCII)
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')


def require(value, message='Transaction evidence is unavailable'):
    if not value:
        raise ValueError(message)


def strict(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'Duplicate evidence field')
            value[key] = item
        return value
    require(len(raw) <= MAXIMUM)
    return json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Invalid number')))


def command(args, maximum=MAXIMUM):
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
        result = subprocess.run(args, stdout=output, stderr=error, stdin=subprocess.DEVNULL,
                                env=ENV, timeout=30)
        require(result.returncode == 0 and output.tell() <= maximum and error.tell() <= maximum)
        output.seek(0)
        return output.read(maximum)


def protected(path, directory=False):
    path = Path(path)
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    info = path.lstat()
    require(info.st_uid == 0 and not info.st_mode & 0o022 and
            (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)))
    return info


def read(path):
    protected(path)
    file = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(os.fstat(file).st_size <= MAXIMUM)
        return strict(os.read(file, MAXIMUM + 1))
    finally:
        os.close(file)


def sync(path):
    file = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(file)
    finally:
        os.close(file)


def publish(path, value, uid=None, public=False):
    raw = json.dumps(value, separators=(',', ':'), sort_keys=True).encode()
    require(len(raw) <= MAXIMUM)
    temporary = str(path) + '.' + secrets.token_hex(16) + '.new'
    file = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(file, 'wb', closefd=False) as output:
            output.write(raw)
            output.flush()
            os.fsync(file)
        if uid is not None:
            command(['/usr/bin/setfacl', '-m', 'u::rw-,u:' + str(uid) + ':r--,g::---,m::r--,o::---', temporary], 4096)
            verify_acl(temporary, uid, False)
        elif public:
            os.fchmod(file, 0o444)
        os.fsync(file)
    finally:
        os.close(file)
    os.replace(temporary, path)
    sync(str(Path(path).parent))


def verify_acl(path, uid, directory):
    rows = command(['/usr/bin/getfacl', '-cpn', str(path)], 4096).decode().splitlines()
    actual = {line for line in rows if line}
    wanted = {'user::rwx' if directory else 'user::rw-',
              'user:' + str(uid) + (':r-x' if directory else ':r--'),
              'group::---', 'mask::r-x' if directory else 'mask::r--', 'other::---'}
    require(actual == wanted, 'Receipt ACL is not read-only for the original user')


def initialize():
    if not Path(RECEIPTS).exists():
        os.mkdir(RECEIPTS, 0o755)
        sync('/var/lib')
        os.mkdir(RECEIPTS + '/users', 0o755)
        publish(RECEIPTS + '/global.json', {'schemaVersion': 1, 'initialized': True,
                                           'generation': 0, 'unresolved': []}, public=True)
    protected(RECEIPTS, True)
    protected(RECEIPTS + '/users', True)
    index = global_index()
    require(type(index['generation']) is int)


def global_index():
    value = read(RECEIPTS + '/global.json')
    require(type(value) is dict and set(value) == {'schemaVersion', 'initialized', 'generation', 'unresolved'} and
            type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and value['initialized'] is True and
            type(value['generation']) is int and 0 <= value['generation'] < 9007199254740991 and
            type(value['unresolved']) is list and len(value['unresolved']) <= 64)
    seen = set()
    for row in value['unresolved']:
        require(type(row) is dict and set(row) == {'attemptId', 'uid'} and
                type(row['attemptId']) is str and UUID.fullmatch(row['attemptId']) and
                type(row['uid']) is int and 0 < row['uid'] <= 2147483647 and row['attemptId'] not in seen)
        seen.add(row['attemptId'])
    return value


def package_state():
    import apt_pkg
    import apt.progress.base
    apt_pkg.init()
    status_before = Path('/var/lib/dpkg/status').stat()
    automatic_path = Path('/var/lib/apt/extended_states')
    automatic_before = automatic_path.stat() if automatic_path.exists() else None
    data = command(['/usr/bin/dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${Architecture}\t${Multi-Arch}\t${db:Status-Abbrev}\n'])
    packages = []
    for line in data.decode().splitlines():
        fields = line.split('\t')
        require(len(fields) == 5 and PACKAGE.fullmatch(fields[0]) and len(fields[1]) <= 128)
        require(fields[4] in ('ii ', 'hi ', 'rc ', 'pc '), 'Package baseline needs external repair')
        packages.append({'package': fields[0], 'version': fields[1], 'architecture': fields[2],
                         'multiArch': fields[3] or 'no', 'status': fields[4]})
    require(len(packages) <= 32768)
    require(not any(Path('/var/lib/dpkg/updates').iterdir()), 'Pending dpkg journal')
    cache = apt_pkg.Cache(apt.progress.base.OpProgress())
    require(apt_pkg.DepCache(cache).broken_count == 0, 'Broken dependency baseline')
    automatic = command(['/usr/bin/apt-mark', 'showauto']).decode().splitlines()
    require(len(automatic) <= 32768 and all(PACKAGE.fullmatch(item) for item in automatic))
    status_after = Path('/var/lib/dpkg/status').stat()
    automatic_after = automatic_path.stat() if automatic_path.exists() else None
    def changed_stamp(info):
        return None if info is None else (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    require(changed_stamp(status_before) == changed_stamp(status_after) and
            changed_stamp(automatic_before) == changed_stamp(automatic_after), 'Package inventory changed while reading')
    require(not any(Path('/var/lib/dpkg/updates').iterdir()), 'Pending dpkg journal')
    return {'packages': sorted(packages, key=lambda item: item['package']), 'automatic': sorted(automatic)}


def parse_plan(raw):
    require(0 < len(raw) <= MAXIMUM and b'\x00' not in raw)
    lines = raw.decode('utf-8', errors='strict').splitlines()
    require(lines and lines.pop(0) == 'VERSION 3', 'APT must supply actual hook protocol 3')
    configuration = []
    while lines and lines[0]:
        line = lines.pop(0)
        require('=' in line and len(line) <= 16384, 'Malformed hook configuration')
        key, value = line.split('=', 1)
        require(re.fullmatch(r'[A-Za-z0-9_:/%.+~-]+', key) and not re.search(r'%(?![0-9a-fA-F]{2})', key + value))
        from urllib.parse import unquote
        configuration.append((unquote(key).lower(), unquote(value)))
    require(lines and lines.pop(0) == '', 'Missing hook boundary')
    for key, value in configuration:
        require(not any(ord(c) < 32 for c in key + value))
        normalized = key.replace('-', '')
        if any(item in normalized for item in ('forceyes', 'allowdowngrades', 'allowchangeheldpackages', 'allowunauthenticated', 'ignorehold', 'fixbroken', 'fixpolicybroken', 'fixmissing', 'automaticremove', 'allowinsecurerepositories', 'allowweakrepositories', 'allowdowngradetoinsecurerepositories', 'debug::nolocking')):
            require(value.lower() in ('false', 'no', '0'), 'Effective APT policy permits prohibited action')
        require(not (key.startswith(('dpkg::pre-invoke', 'dpkg::post-invoke', 'dpkg::options')) and value), 'Uncontrolled effective dpkg hook/options')
    hooks = [value for key, value in configuration if key.startswith('dpkg::pre-install-pkgs::')]
    if hooks:
        require(hooks == [HOOK], 'Uncontrolled actual install hook')
    actions = []
    for line in lines:
        fields = line.split(' ', 8)
        require(len(fields) == 9 and PACKAGE.fullmatch(fields[0]) and all(fields[:8]))
        name, old, old_arch, old_multi, direction, new, new_arch, new_multi, action = fields
        require(old_multi in ('none', 'no', 'same', 'foreign', 'allowed') and
                new_multi in ('none', 'no', 'same', 'foreign', 'allowed') and
                direction in ('<', '=', '>') and len(old) <= 128 and len(new) <= 128)
        require(action in ('**CONFIGURE**', '**REMOVE**') or action.startswith('/'))
        require(len(action) <= 4096 and not any(ord(c) < 32 for c in action))
        actions.append({'package': name, 'oldVersion': old, 'oldArchitecture': old_arch,
                        'oldMultiArch': old_multi, 'direction': direction, 'newVersion': new,
                        'newArchitecture': new_arch, 'newMultiArch': new_multi, 'action': action})
    require(0 < len(actions) <= 4096, 'Empty or excessive actual plan')
    return actions


def source_policy():
    """Reject trust bypasses in both source syntaxes, including disabled entries."""
    paths = [Path('/etc/apt/sources.list')]
    parts = Path('/etc/apt/sources.list.d')
    if parts.exists():
        protected(parts, True)
        paths += sorted(parts.glob('*.list')) + sorted(parts.glob('*.sources'))
    for path in paths:
        if not path.exists():
            continue
        info = protected(path)
        require(info.st_size <= MAXIMUM)
        text = path.read_text(encoding='utf-8')
        # Explicit trust controls must be canonical false/no. Deny ambiguous
        # folding/duplicate options rather than grant a source trust exception.
        bypass = ('trusted', 'allow-insecure', 'allow-weak', 'allow-downgrade-to-insecure')
        if path.suffix == '.sources':
            fields = {}
            current = None
            for line in text.splitlines() + ['']:
                if line.startswith('#'):
                    continue
                if not line.strip():
                    for key in bypass:
                        if key in fields:
                            require(fields[key].strip().lower() in ('no', 'false', '0'), 'Configured repository trust bypass')
                    fields, current = {}, None
                elif line[:1].isspace():
                    require(current is not None)
                    fields[current] += ' ' + line.strip()
                else:
                    require(':' in line)
                    key, value = line.split(':', 1)
                    current = key.lower()
                    require(current not in fields, 'Duplicate repository field')
                    fields[current] = value.strip()
        else:
            for line in text.splitlines():
                line = line.split('#', 1)[0].strip().lower()
                for key in bypass:
                    for match in re.finditer(r'(?:^|[\s\[])' + key + r'\s*=\s*([^\s\]]+)', line):
                        require(match[1] in ('no', 'false', '0'), 'Configured repository trust bypass')
    # Existing root configuration may add hooks and binary-specific policy. Reject
    # unsafe authentication policy even though our invocation ignores these files.
    dump = command(['/usr/bin/apt-config', 'dump']).decode().lower()
    for line in dump.splitlines():
        key, _, value = line.partition(' ')
        if any(name in key for name in ('allowunauthenticated', 'allowinsecurerepositories',
                                       'allowweakrepositories', 'allowdowngradetoinsecurerepositories')):
            require(value.strip(' ;"') not in ('true', 'yes', '1'), 'Global repository trust bypass')


def controlled_config(attempt):
    empty = Path(attempt) / 'empty'
    empty.mkdir(mode=0o700)
    archives = Path(attempt) / 'archives'
    archives.mkdir(mode=0o700)
    (archives / 'partial').mkdir(mode=0o700)
    lines = ['Dir::Etc::parts "' + str(empty) + '";', 'Dir::Etc::main "-";',
             'Dir::Cache::archives "' + str(archives) + '";', 'APT::Sandbox::User "root";',
             '#clear DPkg::Pre-Invoke;', '#clear DPkg::Post-Invoke;', '#clear DPkg::Pre-Install-Pkgs;',
             '#clear APT::Update::Pre-Invoke;', '#clear APT::Update::Post-Invoke;',
             '#clear DPkg::Options;', 'DPkg::Pre-Install-Pkgs { "' + HOOK + '"; };',
             'DPkg::Tools::Options::' + HOOK + '::Version "3";',
             'DPkg::Tools::Options::' + HOOK + '::InfoFD "20";',
             'Dir::Bin::dpkg "/usr/bin/dpkg";', 'Dir::State::status "/var/lib/dpkg/status";',
             'Dir::State::lists "/var/lib/apt/lists";', 'Dir::Etc::sourcelist "/etc/apt/sources.list";',
             'Dir::Etc::sourceparts "/etc/apt/sources.list.d";', 'Debug::NoLocking "false";',
             'APT::Get::Purge "false";', 'APT::Get::Remove "false";', 'APT::Get::allow-remove-essential "false";']
    for key in ['APT::Get::force-yes', 'APT::Get::allow-downgrades', 'APT::Get::allow-change-held-packages',
                'APT::Get::AllowUnauthenticated', 'APT::Ignore-Hold', 'APT::Get::Fix-Broken',
                'APT::Get::Fix-Policy-Broken', 'APT::Get::Fix-Missing', 'APT::Get::AutomaticRemove',
                'Acquire::AllowInsecureRepositories', 'Acquire::AllowWeakRepositories',
                'Acquire::AllowDowngradeToInsecureRepositories']:
        lines.append(key + ' "false";')
    path = str(Path(attempt) / 'apt.conf')
    publish_text(path, ('\n'.join(lines) + '\n').encode())
    return path


def publish_text(path, raw):
    file = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(file, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    sync(str(Path(path).parent))


def archive_control(path):
    info = protected(path)
    require(0 < info.st_size <= 1073741824)
    raw = command(['/usr/bin/dpkg-deb', '--field', path], 65536).decode('utf-8')
    import apt_pkg
    import apt.progress.base
    section = apt_pkg.TagSection(raw)
    value = {key: section.get(key, '') for key in ('Package', 'Version', 'Architecture', 'Multi-Arch',
                                                  'Conflicts', 'Breaks', 'Replaces', 'Provides')}
    require(PACKAGE.fullmatch(value['Package']) and ':' not in value['Package'] and
            0 < len(value['Version']) <= 128 and value['Architecture'] in ('arm64', 'all'))
    value['Multi-Arch'] = value['Multi-Arch'] or 'no'
    require(value['Multi-Arch'] in ('no', 'same', 'foreign', 'allowed') and
            not (value['Architecture'] == 'all' and value['Multi-Arch'] == 'same'))
    file = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    digest = hashlib.sha256()
    try:
        before = os.fstat(file)
        while chunk := os.read(file, 1048576):
            digest.update(chunk)
        after = os.fstat(file)
        require((before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns))
    finally:
        os.close(file)
    return value, digest.hexdigest(), info.st_size


def no_displacement(control, baseline):
    import apt_pkg
    import apt.progress.base
    cache = apt_pkg.Cache(apt.progress.base.OpProgress())
    if control['Package'] == 'shop-things':
        for relationship in ('Conflicts', 'Breaks', 'Replaces'):
            require(not any(name.split(':')[0] == 'electron' for group in apt_pkg.parse_depends(control[relationship], False, 'arm64') for name, _, _ in group), 'Legacy package transition is outside updater authority')
    for relationship in ('Conflicts', 'Breaks', 'Replaces'):
        text = control[relationship]
        for group in apt_pkg.parse_depends(text, False, 'arm64'):
            for name, version, operation in group:
                base, _, qualifier = name.partition(':')
                require(not qualifier or qualifier in ('any', 'native', 'arm64', 'all'), 'Unsupported architecture relationship')
                for installed in baseline['packages']:
                    if installed['status'][1] != 'i':
                        continue
                    installed_name = installed['package'].split(':')[0]
                    # Same qualified package upgrade is not displacing another package.
                    if installed_name == control['Package'] and installed['architecture'] in (control['Architecture'], 'all'):
                        continue
                    if qualifier not in ('', 'any', 'native') and installed['architecture'] not in (qualifier, 'all'):
                        continue
                    identities = [(installed_name, installed['version'])]
                    package = cache[installed['package']]
                    if package.current_ver:
                        records = apt_pkg.PackageRecords(cache)
                        require(records.lookup(package.current_ver.file_list[0]))
                        provides = apt_pkg.TagSection(records.record).get('Provides', '')
                        for provided in apt_pkg.parse_depends(provides, False, 'arm64'):
                            require(len(provided) == 1)
                            identities.append((provided[0][0].split(':')[0], provided[0][1]))
                    for identity, installed_version in identities:
                        if base == identity and (not version or (installed_version and apt_pkg.check_dep(installed_version, operation, version))):
                            raise ValueError('Archive would displace another installed package')


def authenticated_archive(control, path, digest, size):
    import apt_pkg
    import apt.progress.base
    cache = apt_pkg.Cache(apt.progress.base.OpProgress())
    sources = apt_pkg.SourceList()
    require(sources.read_main_list())
    records = apt_pkg.PackageRecords(cache)
    key = control['Package'] + ':' + control['Architecture']
    package = cache[key] if key in cache else cache[control['Package']]
    for version in package.version_list:
        if version.ver_str != control['Version'] or version.arch != control['Architecture']:
            continue
        for entry in version.file_list:
            index = sources.find_index(entry[0])
            if index is None or not index.is_trusted:
                continue
            protected(entry[0].filename)
            require(records.lookup(entry))
            sha = records.hashes.find('SHA256')
            if sha is not None and sha.hashvalue == digest and records.hashes.file_size == size:
                return
    raise ValueError('Repository archive lacks authenticated index hash')


def receipt_path(uid, attempt):
    directory = RECEIPTS + '/users/' + str(uid)
    if not Path(directory).exists():
        os.mkdir(directory, 0o700)
        command(['/usr/bin/setfacl', '-m', 'u::rwx,u:' + str(uid) + ':r-x,g::---,m::r-x,o::---', directory], 4096)
        verify_acl(directory, uid, True)
        sync(RECEIPTS + '/users')
    protected(directory, True)
    verify_acl(directory, uid, True)
    return directory + '/' + attempt + '.json'


def receipt_projection(journal):
    # Projection deliberately omits private root paths and process/environment data.
    projection = {key: journal[key] for key in ('schemaVersion', 'attemptId', 'uid', 'generation', 'manifestDigest',
                    'appVersion', 'packageVersion', 'baselineAppVersion', 'finalAppVersion', 'baseline', 'plan', 'phase', 'outcome', 'errorCode', 'final', 'policyDigest', 'verifiedKeyDigest', 'resolution')}
    projection['plan'] = [[{**row, 'action': 'archive' if row['action'].startswith('/') else 'configure'} for row in batch] for batch in journal['plan']]
    return projection


def persist(journal):
    require(journal['generation'] < 9007199254740991)
    journal['generation'] += 1
    publish(STATE + '/' + journal['attemptId'] + '/journal.json', journal)
    path = receipt_path(journal['uid'], journal['attemptId'])
    projection = receipt_projection(journal)
    publish(path, projection, uid=journal['uid'])
    directory = str(Path(path).parent)
    index_path = directory + '/index.json'
    inventory = read(index_path) if Path(index_path).exists() else {'schemaVersion': 1, 'attempts': []}
    require(set(inventory) == {'schemaVersion', 'attempts'} and type(inventory['schemaVersion']) is int and inventory['schemaVersion'] == 1 and
            type(inventory['attempts']) is list and len(inventory['attempts']) < 64)
    rows = [row for row in inventory['attempts'] if row['attemptId'] != journal['attemptId']]
    rows.append({'attemptId': journal['attemptId'], 'generation': journal['generation'], 'outcome': journal['outcome']})
    publish(index_path, {'schemaVersion': 1, 'attempts': rows}, uid=journal['uid'])


def gate(raw):
    import apt_pkg
    import apt.progress.base
    apt_pkg.init()
    active = read(STATE + '/active.json')
    require(set(active) == {'attemptId', 'aptPid', 'aptStart'})
    pid = os.getppid()
    found = False
    for _ in range(8):
        status = Path('/proc/' + str(pid) + '/status').read_text()
        require(re.search(r'^Uid:\s+0\s+0\s+0\s+0$', status, re.MULTILINE))
        if pid == active['aptPid']:
            stat_text = Path('/proc/' + str(pid) + '/stat').read_text()
            require(stat_text[stat_text.rfind(')') + 2:].split()[19] == active['aptStart'] and
                    os.readlink('/proc/' + str(pid) + '/exe') == '/usr/bin/apt-get')
            require(Path('/proc/' + str(pid) + '/cmdline').read_bytes().split(b'\0')[:-1] ==
                    [b'/usr/bin/apt-get', b'-y', b'--no-remove', b'install', (STATE + '/' + active['attemptId'] + '/artifact.deb').encode()])
            found = True
            break
        pid = int(re.search(r'^PPid:\s+(\d+)$', status, re.MULTILINE)[1])
    require(found, 'Hook is not a child of the owned APT transaction')
    journal = read(STATE + '/' + active['attemptId'] + '/journal.json')
    source_policy()
    fresh = package_state()
    require(read('/usr/lib/shop-things/update/identity.json')['appVersion'] == journal['baselineAppVersion'], 'Installed application baseline changed before gate')
    # Subsequent batches may observe previously authorized mutations, but must
    # still match the accumulated intended tuples for all already-touched packages.
    expected = journal['baseline'] if not journal['plan'] else expected_state(journal)
    require(fresh == expected, 'Package state changed outside the validated transaction')
    actions = parse_plan(raw)
    journal.setdefault('observedPlans', []).append(actions)
    require(len(journal['observedPlans']) <= 32)
    publish(STATE + '/' + journal['attemptId'] + '/journal.json', journal)
    validated = []
    installing = {row['package'].split(':')[0] for row in actions if row['action'].startswith('/')}
    for row in actions:
        require(row['direction'] != '>' and row['action'] != '**REMOVE**' and row['newVersion'] != '-', 'Prohibited actual package action')
        if row['oldVersion'] != '-':
            require(apt_pkg.version_compare(row['newVersion'], row['oldVersion']) >= 0, 'Actual downgrade')
        candidates = [item for item in fresh['packages'] if item['package'].split(':')[0] == row['package'].split(':')[0] and
                      item['architecture'] == row['oldArchitecture'] and item['status'][1] == 'i']
        if row['oldVersion'] == '-':
            require(row['oldArchitecture'] == '-' and not candidates)
        else:
            require(len(candidates) == 1 and candidates[0]['version'] == row['oldVersion'] and
                    candidates[0]['multiArch'] in (row['oldMultiArch'], 'no' if row['oldMultiArch'] == 'none' else row['oldMultiArch']))
            require(candidates[0]['status'][0] != 'h', 'Held package change')
        if row['action'] == '**CONFIGURE**':
            require(row['package'].split(':')[0] in installing or any(item['package'] == row['package'] for batch in journal['plan'] for item in batch),
                    'Unrelated package configuration')
            validated.append(row)
            continue
        path = row['action']
        attempt = STATE + '/' + journal['attemptId']
        require(path == attempt + '/artifact.deb' or (Path(path).parent == Path(attempt + '/archives') and Path(path).name.endswith('.deb')),
                'Archive is outside protected staging/cache')
        control, digest, size = archive_control(path)
        require((control['Package'], control['Version'], control['Architecture']) ==
                (row['package'].split(':')[0], row['newVersion'], row['newArchitecture']) and
                control['Multi-Arch'] in (row['newMultiArch'], 'no' if row['newMultiArch'] == 'none' else row['newMultiArch']))
        require(row['newArchitecture'] in ('arm64', 'all'))
        if control['Package'] == 'shop-things':
            manifest = read(attempt + '/manifest.json')
            require(path == attempt + '/artifact.deb' and control['Version'] == journal['packageVersion'] and
                    control['Architecture'] == 'arm64' and digest == manifest['artifact']['sha256'] and size == manifest['artifact']['byteLength'])
        else:
            authenticated_archive(control, path, digest, size)
        no_displacement(control, journal['baseline'])
        require(row['oldVersion'] != row['newVersion'], 'Unexplained reinstall')
        validated.append({**row, 'sha256': digest, 'byteLength': size})
    require(sum(item['package'].split(':')[0] == 'shop-things' and item['action'].startswith('/')
                for batch in journal['plan'] + [validated] for item in batch) == 1, 'Signed target must occur exactly once')
    journal['plan'].append(validated)
    require(len(journal['plan']) <= 32)
    journal['phase'] = 'mutation-possible'
    persist(journal)  # Both private and caller-readable evidence durable BEFORE dpkg.


def expected_state(journal):
    packages = {item['package']: dict(item) for item in journal['baseline']['packages']}
    for batch in journal['plan']:
        for row in batch:
            name = row['package'].split(':')[0]
            existing = [key for key, item in packages.items() if key.split(':')[0] == name and
                        (item['architecture'] == row['oldArchitecture'] if row['oldVersion'] != '-' else
                         item['architecture'] == row['newArchitecture'] or (item['architecture'] == 'all' and item['status'][1] != 'i'))]
            require(len(existing) <= 1, 'Ambiguous qualified package tuple')
            if existing:
                del packages[existing[0]]
            # dpkg binary:Package qualifies Multi-Arch:same. Supported new
            # architectures are native arm64/all, so neither needs a foreign key.
            key = name + ':' + row['newArchitecture'] if row['newMultiArch'] == 'same' else name
            packages[key] = {'package': key, 'version': row['newVersion'], 'architecture': row['newArchitecture'],
                             'multiArch': 'no' if row['newMultiArch'] == 'none' else row['newMultiArch'], 'status': 'ii '}
    return {'packages': sorted(packages.values(), key=lambda item: item['package']),
            'automatic': journal['baseline']['automatic']}


def unchanged_error(output):
    # English diagnostics from fixed APT argv/LC_ALL=C; this never proves unchanged.
    locks = (b'Could not get lock /var/lib/dpkg/lock', b'Unable to acquire the dpkg frontend lock')
    return 'PACKAGE_LOCK' if any(marker in output for marker in locks) else 'TRANSACTION_REJECTED'


def install(verified, uid):
    import apt_pkg
    import apt.progress.base
    apt_pkg.init()
    protected(Path(apt_pkg.__file__).resolve())
    global_index()  # Bootstrap initializes new state; install never recreates lost evidence.
    lock = os.open(STATE + '/transaction.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        index = global_index()
        require(not index['unresolved'], 'Unresolved system transaction requires recovery')
        source_policy()
        baseline = package_state()
        identity = read('/usr/lib/shop-things/update/identity.json')
        require(identity == {'schemaVersion': 1, 'packageName': 'shop-things', 'appVersion': verified['baseline']['appVersion']}, 'Installed application baseline changed')
        app = next((row for row in baseline['packages'] if row['package'].split(':')[0] == 'shop-things'), None)
        require(app is not None and app['version'] == verified['baseline']['packageVersion'] and app['architecture'] == 'arm64')
        caller_index = Path(RECEIPTS + '/users/' + str(uid) + '/index.json')
        if caller_index.exists():
            inventory = read(caller_index)
            require(type(inventory.get('attempts')) is list and len(inventory['attempts']) < 64, 'Receipt retention capacity requires administrator attention')
        attempt = STATE + '/' + verified['attemptId']
        config = controlled_config(attempt)
        journal = {'schemaVersion': 1, 'attemptId': verified['attemptId'], 'uid': uid, 'generation': 0,
                   'manifestDigest': verified['manifestDigest'], 'appVersion': verified['appVersion'],
                   'packageVersion': verified['packageVersion'], 'policyDigest': verified['policyDigest'], 'verifiedKeyDigest': verified['verifiedKeyDigest'], 'resolution': None, 'baselineAppVersion': identity['appVersion'], 'finalAppVersion': None, 'baseline': baseline, 'plan': [], 'observedPlans': [],
                   'phase': 'pending', 'outcome': 'pending', 'errorCode': None, 'final': None}
        index['generation'] += 1
        index['unresolved'] = [{'attemptId': journal['attemptId'], 'uid': uid}]
        publish(RECEIPTS + '/global.json', index, public=True)
        persist(journal)
        # APT reads this configuration before system parts/main. Those locations
        # are deliberately empty; the single protected hook is the only exec hook.
        environment = {**ENV, 'APT_CONFIG': config}
        with tempfile.TemporaryFile() as output:
            child = subprocess.Popen(['/usr/bin/apt-get', '-y', '--no-remove', 'install', attempt + '/artifact.deb'],
                                     stdin=subprocess.DEVNULL, stdout=output, stderr=output, env=environment)
            stat_text = Path('/proc/' + str(child.pid) + '/stat').read_text()
            publish(STATE + '/active.json', {'attemptId': journal['attemptId'], 'aptPid': child.pid,
                                            'aptStart': stat_text[stat_text.rfind(')') + 2:].split()[19]})
            code = child.wait()  # Never kill/timeout a possibly mutating transaction.
            output.seek(0)
            diagnostic = output.read(65536)  # Classification only; never expose APT output.
        journal = read(attempt + '/journal.json')
        try:
            final = package_state()
            target = next((item for item in final['packages'] if item['package'].split(':')[0] == 'shop-things'), None)
            expected = expected_state(journal)
            # APT legitimately marks newly installed dependencies automatic. The
            # installed tuples must match; unchanged existing auto flags must hold.
            baseline_names = {item['package'].split(':')[0] for item in baseline['packages']}
            require({item for item in final['automatic'] if item.split(':')[0] in baseline_names} == set(baseline['automatic']))
            if code == 0 and journal['plan']:
                installed_identity = read('/usr/lib/shop-things/update/identity.json')
                require(installed_identity == {'schemaVersion': 1, 'packageName': 'shop-things', 'appVersion': verified['appVersion']})
                require(command(['/usr/bin/dpkg-query', '--search', '/opt/Shop Things/shop-things'], 4096).decode().strip() == 'shop-things: /opt/Shop Things/shop-things')
                protected('/opt/Shop Things/shop-things')
            if code == 0 and journal['plan'] and final['packages'] == expected['packages'] and target and target['version'] == verified['packageVersion'] and target['architecture'] == 'arm64':
                journal['outcome'] = 'installed'
            elif not journal['plan'] and final == baseline:
                journal['outcome'] = 'unchanged'
            else:
                journal['outcome'] = 'uncertain'
            journal['final'] = final
            journal['finalAppVersion'] = read('/usr/lib/shop-things/update/identity.json')['appVersion']
        except Exception:
            journal['outcome'] = 'uncertain'
        journal['phase'] = 'complete' if journal['outcome'] in ('installed', 'unchanged') else 'recovery'
        journal['errorCode'] = None if journal['outcome'] == 'installed' else 'PACKAGE_RECOVERY' if journal['outcome'] == 'uncertain' else unchanged_error(diagnostic)
        persist(journal)
        if journal['outcome'] != 'uncertain':
            index['generation'] += 1
            index['unresolved'] = []
            publish(RECEIPTS + '/global.json', index, public=True)
        return {'protocol': 1, 'type': 'outcome', 'attemptId': journal['attemptId'], 'outcome': journal['outcome'], 'errorCode': journal['errorCode']}
    finally:
        os.close(lock)


def validate_receipt(value, uid, attempt):
    require(type(value) is dict and set(value) == {'schemaVersion', 'attemptId', 'uid', 'generation', 'manifestDigest',
            'appVersion', 'packageVersion', 'baselineAppVersion', 'finalAppVersion', 'baseline', 'plan', 'phase', 'outcome', 'errorCode', 'final', 'policyDigest', 'verifiedKeyDigest', 'resolution'})
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and type(value['uid']) is int and value['uid'] == uid and value['attemptId'] == attempt and
            UUID.fullmatch(attempt) and type(value['generation']) is int and 0 < value['generation'] < 9007199254740991 and
            type(value['manifestDigest']) is str and re.fullmatch('[0-9a-f]{64}', value['manifestDigest']) and
            value['outcome'] in ('pending', 'installed', 'unchanged', 'uncertain') and
            value['phase'] in ('pending', 'mutation-possible', 'complete', 'recovery') and
            type(value['plan']) is list and len(value['plan']) <= 32)
    require(all(type(value[key]) is str and re.fullmatch('[0-9a-f]{64}', value[key]) for key in ('policyDigest', 'verifiedKeyDigest')) and value['resolution'] in (None, 'administrator'))
    require(type(value['appVersion']) is str and len(value['appVersion']) <= 128 and VERSION.fullmatch(value['appVersion']) and
            type(value['packageVersion']) is str and len(value['packageVersion']) <= 128)
    for inventory in [value['baseline']] + ([value['final']] if value['final'] is not None else []):
        require(type(inventory) is dict and set(inventory) == {'packages', 'automatic'} and
                type(inventory['packages']) is list and len(inventory['packages']) <= 32768 and
                type(inventory['automatic']) is list and len(inventory['automatic']) <= 32768 and
                all(type(name) is str and PACKAGE.fullmatch(name) for name in inventory['automatic']) and
                len(set(inventory['automatic'])) == len(inventory['automatic']))
        seen = set()
        for row in inventory['packages']:
            require(type(row) is dict and set(row) == {'package', 'version', 'architecture', 'multiArch', 'status'} and
                    type(row['package']) is str and PACKAGE.fullmatch(row['package']) and row['package'] not in seen and
                    all(type(row[key]) is str and 0 < len(row[key]) <= 128 for key in ('version', 'architecture', 'multiArch', 'status')) and
                    row['status'] in ('ii ', 'hi ', 'rc ', 'pc ') and row['multiArch'] in ('no', 'same', 'foreign', 'allowed'))
            seen.add(row['package'])
    require(value['errorCode'] in (None, 'TRANSACTION_REJECTED', 'PACKAGE_RECOVERY', 'PACKAGE_LOCK'))
    require(value['resolution'] is None or (value['outcome'] in ('installed', 'unchanged') and value['phase'] == 'complete'))
    for batch in value['plan']:
        require(type(batch) is list and 0 < len(batch) <= 4096)
        for row in batch:
            fixed = {'package', 'oldVersion', 'oldArchitecture', 'oldMultiArch', 'direction', 'newVersion', 'newArchitecture', 'newMultiArch', 'action'}
            require(type(row) is dict and set(row) == fixed | ({'sha256', 'byteLength'} if row.get('action') == 'archive' else set()))
            require(row['action'] in ('archive', 'configure') and PACKAGE.fullmatch(row['package']) and
                    row['direction'] in ('<', '=') and row['newArchitecture'] in ('arm64', 'all') and
                    row['newMultiArch'] in ('no', 'none', 'same', 'foreign', 'allowed'))
            require(all(type(row[key]) is str and len(row[key]) <= 128 for key in fixed))
            if row['action'] == 'archive':
                require(type(row['sha256']) is str and re.fullmatch('[0-9a-f]{64}', row['sha256']) and
                        type(row['byteLength']) is int and 0 < row['byteLength'] <= 1073741824)
    require(type(value['baselineAppVersion']) is str and len(value['baselineAppVersion']) <= 128 and VERSION.fullmatch(value['baselineAppVersion']) and
            (value['finalAppVersion'] is None or (type(value['finalAppVersion']) is str and len(value['finalAppVersion']) <= 128 and VERSION.fullmatch(value['finalAppVersion']))))
    if value['outcome'] == 'installed':
        targets = [row for batch in value['plan'] for row in batch if row['action'] == 'archive' and row['package'].split(':')[0] == 'shop-things']
        require(value['finalAppVersion'] == value['appVersion'] and value['phase'] == 'complete' and len(targets) == 1 and targets[0]['newVersion'] == value['packageVersion'] and
                targets[0]['newArchitecture'] == 'arm64' and value['final'] is not None and
                value['final']['packages'] == expected_state(value)['packages'])
    if value['outcome'] == 'unchanged':
        require(value['finalAppVersion'] == value['baselineAppVersion'] and value['phase'] == 'complete' and not value['plan'] and value['final'] == value['baseline'])
    return value


def inspect(uid, attempt=None):
    """Read-only, unelevated package gate used by main and original-user supervisor."""
    require(type(uid) is int and uid > 0)
    before = global_index()
    directory = RECEIPTS + '/users/' + str(uid)
    records = {}
    if Path(directory).exists():
        protected(directory, True)
        verify_acl(directory, uid, True)
        inventory_path = directory + '/index.json'
        verify_acl(inventory_path, uid, False)
        inventory = read(inventory_path)
        require(type(inventory) is dict and set(inventory) == {'schemaVersion', 'attempts'} and
                type(inventory['schemaVersion']) is int and inventory['schemaVersion'] == 1 and type(inventory['attempts']) is list and len(inventory['attempts']) <= 64)
        for row in inventory['attempts']:
            require(type(row) is dict and set(row) == {'attemptId', 'generation', 'outcome'} and
                    type(row['attemptId']) is str and UUID.fullmatch(row['attemptId']) and row['attemptId'] not in records and type(row['generation']) is int and 0 < row['generation'] < 9007199254740991 and row['outcome'] in ('pending', 'installed', 'unchanged', 'uncertain'))
            path = directory + '/' + row['attemptId'] + '.json'
            verify_acl(path, uid, False)
            record = validate_receipt(read(path), uid, row['attemptId'])
            require(record['generation'] == row['generation'] and record['outcome'] == row['outcome'])
            records[row['attemptId']] = record
    if any(row['uid'] != uid for row in before['unresolved']):
        return {'outcome': 'uncertain', 'generation': before['generation'], 'state': None, 'receipt': None}
    current_identity = read('/usr/lib/shop-things/update/identity.json')
    require(type(current_identity) is dict and set(current_identity) == {'schemaVersion', 'packageName', 'appVersion'} and type(current_identity['schemaVersion']) is int and current_identity['schemaVersion'] == 1 and current_identity['packageName'] == 'shop-things' and type(current_identity['appVersion']) is str and len(current_identity['appVersion']) <= 128 and VERSION.fullmatch(current_identity['appVersion']))
    fresh = package_state()
    apps = [row for row in fresh['packages'] if row['package'].split(':')[0] == 'shop-things']
    require(len(apps) == 1 and apps[0]['architecture'] == 'arm64' and apps[0]['status'] in ('ii ', 'hi '), 'Configured ARM64 shop-things is required')
    require(command(['/usr/bin/dpkg-query', '--search', '/opt/Shop Things/shop-things'], 4096).decode().strip() in ('shop-things: /opt/Shop Things/shop-things', 'shop-things:arm64: /opt/Shop Things/shop-things'), 'Installed executable ownership changed')
    protected('/opt/Shop Things/shop-things')
    require(current_identity == read('/usr/lib/shop-things/update/identity.json'))
    require(before == global_index(), 'Protected package generation changed during inspection')
    snapshot = {**fresh, 'appVersion': current_identity['appVersion']}
    current = records.get(attempt) if attempt else None
    if attempt is None and before['unresolved']:
        require(len(before['unresolved']) == 1)
        current = records.get(before['unresolved'][0]['attemptId'])
    if current:
        if current['outcome'] in ('installed', 'unchanged') and current['phase'] == 'complete' and current['final'] == fresh and current['finalAppVersion'] == current_identity['appVersion']:
            return {'outcome': current['outcome'], 'generation': before['generation'], 'state': snapshot, 'receipt': current}
        return {'outcome': 'uncertain', 'generation': before['generation'], 'state': snapshot, 'receipt': current}
    require(not before['unresolved'], 'Protected pending receipt is missing')
    # No receipt is not install success: this only proves the initialized system
    # index has no accepted/pending transaction. Main must compare its prelaunch
    # generation+full baseline, fixed child exit and no active invocation as well.
    return {'outcome': 'clean', 'generation': before['generation'], 'state': snapshot, 'receipt': None}
