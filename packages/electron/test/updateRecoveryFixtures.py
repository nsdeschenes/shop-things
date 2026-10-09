"""Real filesystem/fsync/process cuts; privileged ACL/package boundaries are fixtures.
Native installed APT/ACL evidence is a separate disposable ARM64 CI tier.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import hashlib
import fcntl
sys.dont_write_bytecode = True

ATTEMPT = 'b7f650aa-0c51-4d68-a940-7f1472b86b46'
UID = 1000
SOURCE = Path(__file__).parents[1] / 'update/transaction.py'
BASELINE = {'packages': [{'package': 'shop-things', 'version': '1.0.0', 'architecture': 'arm64', 'multiArch': 'no', 'status': 'ii '},
                         {'package': 'fixture-dep', 'version': '1.0.0', 'architecture': 'all', 'multiArch': 'no', 'status': 'ii '}], 'automatic': []}
PLAN = [{'package': 'shop-things', 'oldVersion': '1.0.0', 'oldArchitecture': 'arm64', 'oldMultiArch': 'none', 'direction': '<',
         'newVersion': '2.0.0', 'newArchitecture': 'arm64', 'newMultiArch': 'none', 'action': 'archive', 'sha256': 'a' * 64, 'byteLength': 1}]

def fixture(root):
    spec = importlib.util.spec_from_file_location('transaction', SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.STATE = str(root / 'private')
    module.RECEIPTS = str(root / 'receipts')
    # Only privileged ownership and ACL/system-package boundaries are substituted.
    # Real atomic publications, duplicate parsing, generations and inspection run.
    def protected(path, directory=False):
        if path == '/opt/Shop Things/shop-things':
            path = root / 'executable'
        info = Path(path).lstat()
        module.require(info.st_uid == os.getuid() and not info.st_mode & 0o022 and
                       (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)))
        return info
    module.protected = protected
    module.verify_acl = lambda *args: None
    original_command = module.command
    def command(args, maximum=module.MAXIMUM):
        if args[0] == '/usr/bin/setfacl':
            return b''
        if args[:2] == ['/usr/bin/dpkg-query', '--search']:
            return b'shop-things: /opt/Shop Things/shop-things\n'
        return original_command(args, maximum)
    module.command = command
    original_read = module.read
    def read(path):
        if path == '/usr/lib/shop-things/update/identity.json':
            path = root / 'identity.json'
        return original_read(path)
    module.read = read
    module.package_state = lambda: original_read(root / 'packages.json')
    return module

def initialize(root):
    root.chmod(0o700)
    (root / 'private' / ATTEMPT).mkdir(parents=True, mode=0o700)
    (root / 'receipts/users').mkdir(parents=True, mode=0o755)
    module = fixture(root)
    module.publish(root / 'executable', {'fixture': 'fixed owned executable'})
    module.publish(root / 'identity.json', {'schemaVersion': 1, 'packageName': 'shop-things', 'appVersion': '1.0.0'})
    module.publish(root / 'packages.json', BASELINE)
    module.publish(root / 'receipts/global.json', {'schemaVersion': 1, 'initialized': True, 'generation': 0, 'unresolved': []}, public=True)
    return module

def journal():
    return {'schemaVersion': 1, 'attemptId': ATTEMPT, 'uid': UID, 'generation': 0,
            'manifestDigest': 'a' * 64, 'appVersion': '2.0.0', 'packageVersion': '2.0.0',
            'baselineAppVersion': '1.0.0', 'finalAppVersion': None, 'baseline': copy.deepcopy(BASELINE),
            'policyDigest': 'b' * 64, 'verifiedKeyDigest': 'c' * 64, 'resolution': None, 'plan': [], 'observedPlans': [], 'phase': 'pending', 'outcome': 'pending', 'errorCode': None, 'final': None}

def writer(root, cut):
    module = fixture(root)
    original_publish = module.publish
    phase = 'intent'
    def publish(path, value, **kwargs):
        original_publish(path, value, **kwargs)
        location = 'global' if str(path).endswith('/global.json') else 'index' if str(path).endswith('/index.json') else 'journal' if str(path).endswith('/journal.json') else 'receipt'
        if phase + ':' + location == cut:
            print(json.dumps({'cut': cut, 'pid': os.getpid(), 'start': Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19], 'observation': 'production publish returned after file+directory fsync'}), flush=True)
            os.kill(os.getpid(), signal.SIGSTOP)
    module.publish = publish
    module.publish(root / 'receipts/global.json', {'schemaVersion': 1, 'initialized': True, 'generation': 1, 'unresolved': [{'attemptId': ATTEMPT, 'uid': UID}]}, public=True)
    value = journal()
    module.persist(value)
    phase = 'plan'
    value['plan'] = [[{**row, 'action': module.STATE + '/' + ATTEMPT + '/artifact.deb'} for row in PLAN]]
    value['phase'] = 'mutation-possible'
    module.persist(value)
    phase = 'installed'
    final = module.expected_state(value)
    module.publish(root / 'packages.json', final)
    module.publish(root / 'identity.json', {'schemaVersion': 1, 'packageName': 'shop-things', 'appVersion': '2.0.0'})
    value.update(outcome='installed', phase='complete', final=final, finalAppVersion='2.0.0')
    module.persist(value)
    phase = 'complete'
    module.publish(root / 'receipts/global.json', {'schemaVersion': 1, 'initialized': True, 'generation': 2, 'unresolved': []}, public=True)
    raise AssertionError('Cut marker was not reached')

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.module = initialize(self.root)
    def tearDown(self):
        self.temporary.cleanup()
    def cut(self, cut):
        process = subprocess.Popen(['/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--writer', str(self.root), cut], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertTrue(select.select([process.stdout], [], [], 5)[0], 'Durable marker was not reached')
            raw = process.stdout.readline()
            self.assertTrue(raw, 'Writer exited before durable marker')
            evidence = json.loads(raw)
            self.assertEqual(evidence['cut'], cut)
            self.assertEqual(evidence['pid'], process.pid)
            self.assertEqual(evidence['start'], Path('/proc/' + str(process.pid) + '/stat').read_text().rsplit(')', 1)[1].split()[19])
            process.kill()
            self.assertEqual(process.wait(timeout=5), -signal.SIGKILL)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()
        return evidence
    def test_cuts_in_each_intent_publication_never_become_clean_or_success(self):
        for cut in ['intent:global', 'intent:journal', 'intent:receipt', 'intent:index', 'plan:journal', 'plan:receipt', 'plan:index', 'installed:journal', 'installed:receipt']:
            with self.subTest(cut=cut), tempfile.TemporaryDirectory() as directory:
                original_root, original_module = self.root, self.module
                self.root = Path(directory)
                self.module = initialize(self.root)
                try:
                    self.cut(cut)
                    try:
                        evidence = self.module.inspect(UID)
                    except (ValueError, FileNotFoundError):
                        continue
                    self.assertEqual(evidence['outcome'], 'uncertain')
                finally:
                    self.root, self.module = original_root, original_module
    def test_complete_root_outcome_precedes_global_pending_removal_and_ignores_user_records(self):
        self.cut('installed:index')
        evidence = self.module.inspect(UID, ATTEMPT)
        self.assertEqual(evidence['outcome'], 'installed')
        self.assertTrue(self.module.global_index()['unresolved'])
        user = self.root / 'user-updates'
        user.mkdir(mode=0o700)
        (user / 'install.json').write_text('{"outcome":"failed"}')
        self.assertEqual(self.module.inspect(UID, ATTEMPT)['outcome'], 'installed')
        (user / 'install.json').unlink()
        self.assertEqual(self.module.inspect(UID, ATTEMPT)['outcome'], 'installed')
        self.assertEqual(self.module.inspect(UID + 1)['outcome'], 'uncertain')
    def test_lost_final_root_outcome_is_not_inferred_from_configured_intended_state(self):
        self.cut('plan:index')
        value = self.module.read(self.root / 'private' / ATTEMPT / 'journal.json')
        self.module.publish(self.root / 'packages.json', self.module.expected_state(value))
        self.module.publish(self.root / 'identity.json', {'schemaVersion': 1, 'packageName': 'shop-things', 'appVersion': '2.0.0'})
        self.assertEqual(self.module.inspect(UID, ATTEMPT)['outcome'], 'uncertain')
    def test_full_dependency_state_must_match_even_when_app_version_matches(self):
        self.cut('installed:index')
        changed = self.module.read(self.root / 'packages.json')
        changed['packages'][0]['version'] = '9.0.0'
        self.module.publish(self.root / 'packages.json', changed)
        self.assertEqual(self.module.inspect(UID, ATTEMPT)['outcome'], 'uncertain')
    def test_missing_corrupt_duplicate_global_and_receipt_records_fail_closed(self):
        self.cut('installed:index')
        receipt = self.root / 'receipts/users' / str(UID) / (ATTEMPT + '.json')
        original = receipt.read_bytes()
        for raw in [b'{}', b'{"schemaVersion":1,"schemaVersion":1}', b'null', b'{']:
            receipt.write_bytes(raw)
            with self.assertRaises((ValueError, TypeError)):
                self.module.inspect(UID)
        receipt.write_bytes(original)
        receipt.unlink()
        with self.assertRaises(FileNotFoundError):
            self.module.inspect(UID)
        (self.root / 'receipts/global.json').unlink()
        with self.assertRaises(FileNotFoundError):
            self.module.inspect(UID)
    def test_root_schema_integer_fields_reject_booleans_and_float_uid(self):
        value = journal()
        value.pop('observedPlans')
        value['generation'] = 1
        for field, invalid in [('schemaVersion', True), ('uid', float(UID)), ('generation', True)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.module.validate_receipt({**value, field: invalid}, UID, ATTEMPT)
        path = self.root / 'receipts/global.json'
        self.module.publish(path, {'schemaVersion': True, 'initialized': True, 'generation': 0, 'unresolved': []}, public=True)
        with self.assertRaises(ValueError):
            self.module.global_index()
        self.module.publish(path, {'schemaVersion': 1, 'initialized': True, 'generation': True, 'unresolved': []}, public=True)
        with self.assertRaises(ValueError):
            self.module.global_index()
        self.module.publish(path, {'schemaVersion': 1, 'initialized': True, 'generation': 0, 'unresolved': []}, public=True)
        self.module.publish(self.root / 'identity.json', {'schemaVersion': True, 'packageName': 'shop-things', 'appVersion': '1.0.0'})
        with self.assertRaises(ValueError):
            self.module.inspect(UID)
    def test_canonical_app_versions_required_in_receipts_and_current_identity(self):
        value = journal()
        value.pop('observedPlans')
        value['generation'] = 1
        for version in ['1.0.0+.', '1.0.0+a..b', '1.0.0+é', '01.0.0', '1.0.0-rc.1']:
            for field in ['appVersion', 'baselineAppVersion', 'finalAppVersion']:
                with self.subTest(version=version, field=field), self.assertRaises(ValueError):
                    self.module.validate_receipt({**value, field: version}, UID, ATTEMPT)
            self.module.publish(self.root / 'identity.json', {'schemaVersion': 1, 'packageName': 'shop-things', 'appVersion': version})
            with self.subTest(version=version), self.assertRaises(ValueError):
                self.module.inspect(UID)
    def resolver(self):
        spec = importlib.util.spec_from_file_location('recovery', SOURCE.parent / 'recovery.py')
        recovery = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(recovery)
        spec = importlib.util.spec_from_file_location('helper', SOURCE.parent / 'updater-helper.py')
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        def protected_bytes(path, maximum):
            if path == '/usr/lib/shop-things/update/identity.json':
                path = self.root / 'identity.json'
            self.module.protected(path)
            raw = Path(path).read_bytes()
            self.module.require(0 < len(raw) <= maximum)
            return raw
        helper.protected_bytes = protected_bytes
        recovery.load_fixed = lambda path, name: self.module if name == 'transaction' else helper
        recovery.LOCKS = [str(self.root / 'frontend.lock'), str(self.root / 'dpkg.lock')]
        for path in [self.root / 'private/transaction.lock', *map(Path, recovery.LOCKS)]:
            path.write_bytes(b'')
            path.chmod(0o600)
        return recovery
    def signed_intent(self, planned=True):
        attempt = self.root / 'private' / ATTEMPT
        code = self.root / 'package'
        (code / 'DEBIAN').mkdir(parents=True)
        (code / 'DEBIAN/control').write_text('Package: shop-things\nVersion: 2.0.0\nArchitecture: arm64\nMaintainer: Fixture\nDescription: Controlled recovery archive\n')
        identity = code / 'opt/Shop Things/resources/update/identity.json'
        identity.parent.mkdir(parents=True)
        identity.write_text(json.dumps({'schemaVersion': 1, 'packageName': 'shop-things', 'appVersion': '2.0.0'}))
        subprocess.run(['/usr/bin/dpkg-deb', '--build', '--root-owner-group', str(code), str(attempt / 'artifact.deb')], check=True, capture_output=True)
        (attempt / 'artifact.deb').chmod(0o600)
        private = self.root / 'test-only-private.pem'
        subprocess.run(['/usr/bin/openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(private)], check=True, capture_output=True)
        public = subprocess.run(['/usr/bin/openssl', 'pkey', '-in', str(private), '-pubout'], check=True, capture_output=True).stdout
        (attempt / 'key-0.pem').write_bytes(public)
        policy = json.dumps({'schemaVersion': 1, 'helperProtocol': 1, 'trustedKeys': [public.decode()]}).encode()
        (attempt / 'policy.json').write_bytes(policy)
        payload = (attempt / 'artifact.deb').read_bytes()
        artifact = {'filename': 'shop-things-2.0.0-linux-arm64.deb', 'byteLength': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}
        manifest = {'schemaVersion': 1, 'applicationId': 'com.shopthings.app', 'repository': 'nsdeschenes/shop-things', 'channel': 'stable',
                    'appVersion': '2.0.0', 'packageName': 'shop-things', 'packageVersion': '2.0.0', 'platform': 'linux', 'architecture': 'arm64',
                    'helperProtocol': {'min': 1, 'max': 1}, 'artifact': artifact}
        manifest_raw = json.dumps(manifest).encode()
        (attempt / 'manifest.json').write_bytes(manifest_raw)
        subprocess.run(['/usr/bin/openssl', 'pkeyutl', '-sign', '-rawin', '-inkey', str(private), '-in', str(attempt / 'manifest.json'), '-out', str(attempt / 'manifest.sig')], check=True, capture_output=True)
        for path in [attempt / name for name in ['key-0.pem', 'policy.json', 'manifest.json', 'manifest.sig']]:
            path.chmod(0o600)
        value = journal()
        value.update(policyDigest=hashlib.sha256(policy).hexdigest(), verifiedKeyDigest=hashlib.sha256(public).hexdigest(), manifestDigest=hashlib.sha256(manifest_raw).hexdigest())
        if planned:
            row = {**PLAN[0], 'action': str(attempt / 'artifact.deb'), 'sha256': artifact['sha256'], 'byteLength': len(payload)}
            value.update(plan=[[row]], observedPlans=[[{key: item for key, item in row.items() if key not in ('sha256', 'byteLength')}]], phase='mutation-possible')
            self.module.publish(self.root / 'packages.json', self.module.expected_state(value))
            self.module.publish(self.root / 'identity.json', {'schemaVersion': 1, 'packageName': 'shop-things', 'appVersion': '2.0.0'})
        self.module.publish(self.root / 'receipts/global.json', {'schemaVersion': 1, 'initialized': True, 'generation': 1, 'unresolved': [{'attemptId': ATTEMPT, 'uid': UID}]}, public=True)
        self.module.persist(value)
        return attempt
    def test_manual_locked_resolution_verifies_retained_signature_and_never_runs_package_mutation(self):
        attempt = self.signed_intent()
        recovery = self.resolver()
        before = self.module.read(self.root / 'packages.json')
        # A killed writer's retained temporary file never authorizes settlement or
        # prevents publishing a fresh independent record. Preserve it as evidence.
        stale = attempt / 'journal.json.new'
        stale.write_text('retained partial publication')
        stale.chmod(0o600)
        # Current policy changes do not erase independently retained authorized trust.
        (self.root / 'current-policy.json').write_text('{"rotated":"unrelated"}')
        with patch.object(os, 'geteuid', return_value=0):
            result = recovery.resolve(ATTEMPT)
        self.assertEqual(result['outcome'], 'installed')
        self.assertEqual(self.module.read(self.root / 'packages.json'), before)
        self.assertEqual(self.module.global_index()['unresolved'], [])
        self.assertEqual(self.module.inspect(UID, ATTEMPT)['receipt']['resolution'], 'administrator')
        self.assertTrue((attempt / 'policy.json').exists())
        self.assertEqual(stale.read_text(), 'retained partial publication')
    def test_manual_resolution_is_blocked_by_real_posix_package_lock_and_preserves_pending(self):
        self.signed_intent()
        recovery = self.resolver()
        child = subprocess.Popen(['/usr/bin/python3', '-I', '-c', "import fcntl,sys,signal; f=open(sys.argv[1],'r+'); fcntl.lockf(f,fcntl.LOCK_EX); print('locked',flush=True); signal.pause()", recovery.LOCKS[0]], stdout=subprocess.PIPE)
        try:
            self.assertTrue(select.select([child.stdout], [], [], 5)[0])
            self.assertEqual(child.stdout.readline(), b'locked\n')
            with patch.object(os, 'geteuid', return_value=0), self.assertRaises(BlockingIOError):
                recovery.resolve(ATTEMPT)
            self.assertTrue(self.module.global_index()['unresolved'])
        finally:
            child.kill()
            child.wait(timeout=5)
            child.stdout.close()
    def test_manual_empty_plan_unchanged_restores_only_independently_proven_baseline(self):
        self.signed_intent(planned=False)
        recovery = self.resolver()
        with patch.object(os, 'geteuid', return_value=0):
            self.assertEqual(recovery.resolve(ATTEMPT)['outcome'], 'unchanged')
        self.assertEqual(self.module.inspect(UID, ATTEMPT)['outcome'], 'unchanged')
    def test_manual_resolver_refuses_missing_signature_corrupt_trust_and_partial_state(self):
        attempt = self.signed_intent()
        recovery = self.resolver()
        policy = (attempt / 'policy.json').read_bytes()
        (attempt / 'policy.json').write_text('{"trustedKeys":[]}')
        with patch.object(os, 'geteuid', return_value=0), self.assertRaises(ValueError):
            recovery.resolve(ATTEMPT)
        (attempt / 'policy.json').write_bytes(policy)
        fresh = self.module.read(self.root / 'packages.json')
        fresh['packages'][0]['status'] = 'iU '
        self.module.publish(self.root / 'packages.json', fresh)
        with patch.object(os, 'geteuid', return_value=0), self.assertRaises(ValueError):
            recovery.resolve(ATTEMPT)
        (attempt / 'manifest.sig').unlink()
        with patch.object(os, 'geteuid', return_value=0), self.assertRaises(FileNotFoundError):
            recovery.resolve(ATTEMPT)
        self.assertTrue(self.module.global_index()['unresolved'])
    def test_live_owned_apt_identity_blocks_manual_resolution_even_before_package_lock(self):
        self.signed_intent()
        recovery = self.resolver()
        self.module.publish(self.root / 'private/active.json', {'attemptId': ATTEMPT, 'aptPid': os.getpid(), 'aptStart': Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]})
        with patch.object(os, 'geteuid', return_value=0), self.assertRaisesRegex(ValueError, 'APT process is still active'):
            recovery.resolve(ATTEMPT)
        self.assertTrue(self.module.global_index()['unresolved'])
    def test_manual_cli_rejects_unprivileged_or_non_arm64_invocations(self):
        result = subprocess.run(['/usr/bin/python3', '-I', str(SOURCE.parent / 'resolve-update'), ATTEMPT], capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'No package operation was performed', result.stderr)
    def test_external_exec_observer_kills_only_owned_child_before_program_runs(self):
        # repository root is one level above packages; no fixture code is shipped.
        source = Path(__file__).parents[3] / 'acceptance/update-apt/interruption.py'
        spec = importlib.util.spec_from_file_location('interruption', source)
        interruption = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(interruption)
        script = "import subprocess,sys; subprocess.run(['/usr/bin/python3','-I','-c', 'print(123)', 'cut-owned-child']); print('parent survived')"
        result = interruption.traced_process(['/usr/bin/python3', '-I', '-c', script], b'', {'PATH': '/usr/bin:/bin'},
                                             lambda root, pid, command: pid if command[-1] == 'cut-owned-child' else None)
        self.assertEqual(result['returncode'], 0)
        self.assertEqual(result['stdout'], b'parent survived\n')
        self.assertEqual(result['cut']['pid'], result['cut']['killedPid'])
        self.assertEqual(result['cut']['event'], 'exec-before-first-instruction')
    def test_expected_qualified_tuples_match_real_dpkg_query_without_installing_packages(self):
        # dpkg-query operates against a disposable status database; host package
        # state is neither installed nor changed. Genuine dpkg canonicalization.
        administrative = self.root / 'isolated-dpkg'
        administrative.mkdir()
        native = subprocess.check_output(['/usr/bin/dpkg','--print-architecture']).decode().strip()
        for old_architecture, old_multi, new_architecture, new_multi in [('arm64','no','arm64','same'),('arm64','same','arm64','no'),('arm64','no','all','no'),('all','no','arm64','same')]:
            with self.subTest(old=old_multi,new=new_multi,architecture=new_architecture):
                name = 'fixture-canonical:' + old_architecture if old_multi == 'same' else 'fixture-canonical'
                old = {'package':name,'version':'1.0.0','architecture':old_architecture,'multiArch':old_multi,'status':'ii '}
                value = journal()
                value['baseline']['packages'] = [old, {'package':'unrelated:amd64','version':'1.0.0','architecture':'amd64','multiArch':'same','status':'ii '}]
                value['plan'] = [[{**PLAN[0],'package':'fixture-canonical','oldArchitecture':old_architecture,'oldMultiArch':old_multi,'newArchitecture':new_architecture,'newMultiArch':new_multi}]]
                expected = self.module.expected_state(value)['packages']
                actual_architecture = native if new_architecture == 'arm64' else new_architecture
                (administrative / 'status').write_text('Package: fixture-canonical\nStatus: install ok installed\nMaintainer: Fixture\nVersion: 2.0.0\nArchitecture: ' + actual_architecture + '\nMulti-Arch: ' + new_multi + '\nDescription: fixture\n\n')
                result = subprocess.run(['/usr/bin/dpkg-query','--admindir=' + str(administrative),'-W','-f=${binary:Package}\t${Version}\t${Architecture}\t${Multi-Arch}\t${db:Status-Abbrev}\n'],capture_output=True,check=True)
                fields = result.stdout.decode().rstrip('\n').split('\t')
                # The real query uses this host's native architecture; the
                # production transaction is fixed to native ARM64. Map only that
                # explicit test platform boundary, preserving canonical suffixes.
                if fields[0].endswith(':' + native):
                    fields[0] = fields[0].rsplit(':',1)[0] + ':arm64'
                if fields[2] == native:
                    fields[2] = 'arm64'
                self.assertEqual(expected[0],dict(zip(('package','version','architecture','multiArch','status'),fields)))
                self.assertEqual(expected[1]['package'],'unrelated:amd64')
        value['baseline']['packages'] = [value['baseline']['packages'][1]]
        value['plan'][0][0].update(oldVersion='-',oldArchitecture='-')
        self.assertEqual(self.module.expected_state(value)['packages'][0]['package'],'fixture-canonical:arm64')
    def test_fixed_extensionless_helper_module_loader_does_not_depend_on_py_suffix(self):
        destination = self.root / 'fixed-helper'
        destination.write_text('value = 1')
        original_lstat = Path.lstat
        def protected_fixture_lstat(path):
            self.assertIn(path, [destination, *destination.parents])
            info = original_lstat(path)
            return SimpleNamespace(st_uid=0,st_mode=info.st_mode & ~0o022)
        with patch.object(Path,'lstat',protected_fixture_lstat):
            # resolver() substitutes ownership/loading only for its full-root
            # fixtures; load this production loader separately for real parsing.
            spec = importlib.util.spec_from_file_location('fixed_recovery_loader', SOURCE.parent / 'recovery.py')
            actual = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(actual)
            module = actual.load_fixed(str(destination),'controlled_fixed_helper')
            self.assertEqual(module.value,1)
    def test_external_observer_accepts_real_child_stop_before_parent_fork_notification(self):
        source = Path(__file__).parents[3] / 'acceptance/update-apt/interruption.py'
        spec = importlib.util.spec_from_file_location('interruption', source)
        observer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(observer)
        original_waitpid = os.waitpid
        deferred = []
        owned = set()
        reordered = False
        def deliver_child_first(pid, flags):
            nonlocal reordered
            if deferred:
                return deferred.pop()
            result = original_waitpid(pid, flags)
            if result[0] > 0:
                owned.add(result[0])
            if not reordered and result[1] >> 16 in (1, 2, 3):
                # Both statuses are genuine kernel events. Linux permits their
                # delivery in either order; force the formerly failing order.
                deferred.append(result)
                child_result = original_waitpid(-1, observer.WALL)
                self.assertTrue(os.WIFSTOPPED(child_result[1]))
                self.assertEqual(os.WSTOPSIG(child_result[1]),signal.SIGSTOP)
                self.assertNotEqual(child_result[0],result[0])
                owned.add(child_result[0])
                reordered = True
                return child_result
            return result
        try:
            with patch.object(os,'waitpid',deliver_child_first):
                result = observer.traced_process(['/usr/bin/python3','-I','-c',"import subprocess; subprocess.run(['/bin/true','cut-owned-child']); print('parent survived')"],b'',{'PATH':'/usr/bin:/bin'},
                                                 lambda root,pid,command: pid if command[-1] == 'cut-owned-child' else None)
            self.assertTrue(reordered)
            self.assertEqual(result['earlyChildStops'],1)
            self.assertEqual(result['stdout'],b'parent survived\n')
            self.assertEqual(result['returncode'],0)
            self.assertEqual(result['cut']['pid'],result['cut']['killedPid'])
        finally:
            for pid in owned:
                try: os.kill(pid,signal.SIGKILL)
                except ProcessLookupError: pass
            for pid in owned:
                try:
                    while True:
                        _,status = original_waitpid(pid,observer.WALL)
                        if os.WIFEXITED(status) or os.WIFSIGNALED(status): break
                except ChildProcessError: pass
    def test_clean_index_does_not_make_missing_or_wrong_architecture_app_usable(self):
        for packages in [[], [{**BASELINE['packages'][0], 'architecture': 'amd64'}]]:
            self.module.publish(self.root / 'packages.json', {'packages': packages, 'automatic': []})
            with self.assertRaises(ValueError):
                self.module.inspect(UID)

if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--writer':
        writer(Path(sys.argv[2]), sys.argv[3])
    else:
        unittest.main()
