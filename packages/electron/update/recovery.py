"""Explicit administrator evidence resolution. Never mutate or replay packages."""
import contextlib
import fcntl
import hashlib
import importlib.util
from importlib.machinery import SourceFileLoader
import os
from pathlib import Path
import stat

LOCKS = ['/var/lib/dpkg/lock-frontend', '/var/lib/dpkg/lock']

def load_fixed(path, name):
    for item in [Path(path), *Path(path).parents]:
        info = item.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise ValueError('Protected recovery code is unavailable')
    if not Path(path).is_file():
        raise ValueError('Protected recovery code is unavailable')
    spec = importlib.util.spec_from_file_location(name, path, loader=SourceFileLoader(name, path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def verify_intent(transaction, helper, journal, attempt):
    projection = transaction.receipt_projection(journal)
    transaction.validate_receipt(projection, journal['uid'], journal['attemptId'])
    transaction.require(set(journal) == set(projection) | {'observedPlans'} and
                        type(journal['observedPlans']) is list and len(journal['plan']) <= len(journal['observedPlans']) <= len(journal['plan']) + 1)
    observed_fields = {'package', 'oldVersion', 'oldArchitecture', 'oldMultiArch', 'direction', 'newVersion', 'newArchitecture', 'newMultiArch', 'action'}
    for batch in journal['observedPlans']:
        transaction.require(type(batch) is list and 0 < len(batch) <= 4096)
        for row in batch:
            transaction.require(type(row) is dict and set(row) == observed_fields and
                                all(type(value) is str and len(value) <= (4096 if key == 'action' else 128) for key, value in row.items()) and
                                transaction.PACKAGE.fullmatch(row['package']))
    policy_raw = helper.protected_bytes(attempt + '/policy.json', 65536)
    transaction.require(hashlib.sha256(policy_raw).hexdigest() == journal['policyDigest'])
    policy = helper.strict_json(policy_raw)
    helper.exact(policy, ['schemaVersion', 'helperProtocol', 'trustedKeys'])
    transaction.require(type(policy['schemaVersion']) is int and policy['schemaVersion'] == 1 and
                        type(policy['helperProtocol']) is int and policy['helperProtocol'] == 1 and
                        type(policy['trustedKeys']) is list and 0 < len(policy['trustedKeys']) <= 16 and
                        all(type(pem) is str for pem in policy['trustedKeys']) and len(set(policy['trustedKeys'])) == len(policy['trustedKeys']))
    manifest_raw = helper.protected_bytes(attempt + '/manifest.json', 65536)
    transaction.require(hashlib.sha256(manifest_raw).hexdigest() == journal['manifestDigest'])
    transaction.require(len(helper.protected_bytes(attempt + '/manifest.sig', 64)) == 64)
    verified = False
    for index, pem in enumerate(policy['trustedKeys']):
        transaction.require(len(pem) <= 4096 and pem.startswith('-----BEGIN PUBLIC KEY-----\n'))
        path = attempt + '/key-' + str(index) + '.pem'
        transaction.require(helper.protected_bytes(path, 4096) == pem.encode())
        transaction.require(helper.tool(['/usr/bin/openssl', 'pkey', '-pubin', '-in', path, '-pubout']) == pem.encode())
        der = helper.tool(['/usr/bin/openssl', 'pkey', '-pubin', '-in', path, '-pubout', '-outform', 'DER'])
        transaction.require(len(der) == 44 and der[:12] == bytes.fromhex('302a300506032b6570032100'))
        if hashlib.sha256(pem.encode()).hexdigest() == journal['verifiedKeyDigest']:
            helper.tool(['/usr/bin/openssl', 'pkeyutl', '-verify', '-rawin', '-pubin', '-inkey', path, '-in', attempt + '/manifest.json', '-sigfile', attempt + '/manifest.sig'])
            verified = True
    transaction.require(verified, 'Retained verified publisher key is missing')
    manifest = helper.strict_json(manifest_raw)
    app_version, package_version, artifact = helper.validate_manifest(manifest)
    transaction.require(app_version == journal['appVersion'] and package_version == journal['packageVersion'])
    baseline_apps = [row for row in journal['baseline']['packages'] if row['package'].split(':')[0] == 'shop-things']
    transaction.require(len(baseline_apps) == 1 and baseline_apps[0]['architecture'] == 'arm64' and baseline_apps[0]['status'] == 'ii ')
    transaction.require(tuple(map(int, app_version.split('+')[0].split('.'))) > tuple(map(int, journal['baselineAppVersion'].split('+')[0].split('.'))))
    helper.tool(['/usr/bin/dpkg', '--compare-versions', package_version, 'gt', baseline_apps[0]['version']])
    control, digest, size = transaction.archive_control(attempt + '/artifact.deb')
    transaction.require(control['Package'] == 'shop-things' and control['Architecture'] == 'arm64' and
                        control['Version'] == package_version and digest == artifact['sha256'] and size == artifact['byteLength'] and
                        helper.package_identity(attempt + '/artifact.deb')['appVersion'] == app_version)
    for index, batch in enumerate(journal['plan']):
        observed = [{key: value for key, value in row.items() if key not in ('sha256', 'byteLength')} for row in batch]
        transaction.require(observed == journal['observedPlans'][index], 'Actual plan evidence is incomplete')
        for row in batch:
            if row['action'] == '**CONFIGURE**':
                continue
            path = Path(row['action'])
            transaction.require(str(path) == attempt + '/artifact.deb' or
                                (path.parent == Path(attempt + '/archives') and path.name.endswith('.deb')))
            control, digest, size = transaction.archive_control(str(path))
            transaction.require(digest == row['sha256'] and size == row['byteLength'] and
                                (control['Package'], control['Version'], control['Architecture']) ==
                                (row['package'].split(':')[0], row['newVersion'], row['newArchitecture']))
    return projection

def resolve(attempt_id):
    if os.geteuid() != 0:
        raise ValueError('Explicit administrator execution is required')
    transaction = load_fixed('/usr/lib/shop-things/update/transaction.py', 'transaction')
    helper = load_fixed('/usr/lib/shop-things/updater-helper', 'helper')
    transaction.require(type(attempt_id) is str and transaction.UUID.fullmatch(attempt_id))
    attempt = transaction.STATE + '/' + attempt_id
    with contextlib.ExitStack() as locks:
        for index, path in enumerate([transaction.STATE + '/transaction.lock', *LOCKS]):
            transaction.protected(path)
            descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
            locks.callback(os.close, descriptor)
            if index == 0:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                fcntl.lockf(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        global_index = transaction.global_index()
        journal = transaction.read(attempt + '/journal.json')
        transaction.require(type(journal) is dict and journal.get('attemptId') == attempt_id and
                            type(journal.get('uid')) is int and journal['uid'] > 0)
        transaction.require(global_index['unresolved'] == [{'attemptId': attempt_id, 'uid': journal['uid']}],
                            'Resolution requires one intact unresolved attempt')
        verify_intent(transaction, helper, journal, attempt)
        active_path = Path(transaction.STATE + '/active.json')
        if active_path.exists():
            active = transaction.read(str(active_path))
            transaction.require(type(active) is dict and set(active) == {'attemptId', 'aptPid', 'aptStart'} and
                                type(active['attemptId']) is str and transaction.UUID.fullmatch(active['attemptId']) and
                                type(active['aptPid']) is int and 1 < active['aptPid'] <= 2147483647 and type(active['aptStart']) is str and
                                0 < len(active['aptStart']) <= 24 and active['aptStart'].isascii() and active['aptStart'].isdigit())
            proc = Path('/proc/' + str(active['aptPid']) + '/stat')
            try:
                fields = proc.read_text().rsplit(')', 1)[1].split()
                transaction.require(fields[0] == 'Z' or fields[19] != active['aptStart'], 'The owned APT process is still active')
            except (FileNotFoundError, ProcessLookupError):
                pass
        fresh = transaction.package_state()
        identity = helper.identity(helper.protected_bytes('/usr/lib/shop-things/update/identity.json', 4096))
        transaction.require(transaction.command(['/usr/bin/dpkg-query', '--search', '/opt/Shop Things/shop-things'], 4096).decode().strip() in
                            ('shop-things: /opt/Shop Things/shop-things', 'shop-things:arm64: /opt/Shop Things/shop-things'))
        transaction.protected('/opt/Shop Things/shop-things')
        baseline_names = {row['package'].split(':')[0] for row in journal['baseline']['packages']}
        transaction.require({name for name in fresh['automatic'] if name.split(':')[0] in baseline_names} == set(journal['baseline']['automatic']))
        targets = [row for batch in journal['plan'] for row in batch if row['action'].startswith('/') and row['package'].split(':')[0] == 'shop-things']
        if (len(targets) == 1 and targets[0]['newVersion'] == journal['packageVersion'] and targets[0]['newArchitecture'] == 'arm64' and
                fresh['packages'] == transaction.expected_state(journal)['packages'] and identity['appVersion'] == journal['appVersion']):
            outcome = 'installed'
        elif not journal['plan'] and fresh == journal['baseline'] and identity['appVersion'] == journal['baselineAppVersion']:
            outcome = 'unchanged'
        else:
            raise ValueError('Fresh package state is not independently resolved')
        journal.update(outcome=outcome, phase='complete', final=fresh, finalAppVersion=identity['appVersion'],
                       errorCode=None if outcome == 'installed' else 'TRANSACTION_REJECTED', resolution='administrator')
        transaction.validate_receipt(transaction.receipt_projection(journal), journal['uid'], attempt_id)
        transaction.persist(journal)
        global_index['generation'] += 1
        global_index['unresolved'] = []
        transaction.publish(transaction.RECEIPTS + '/global.json', global_index, public=True)
        return {'schemaVersion': 1, 'attemptId': attempt_id, 'outcome': outcome, 'resolution': 'administrator'}
