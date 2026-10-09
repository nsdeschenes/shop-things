import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import sys
sys.dont_write_bytecode = True


class HelperVerification(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path.home() / '.cache')
        self.root = Path(self.temporary.name)
        source = Path(__file__).resolve().parents[1] / 'update/updater-helper.py'
        spec = importlib.util.spec_from_file_location('helper', source)
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.helper.ROOT_UID = os.getuid()  # Protected filesystem owner boundary only.
        self.helper.STATE = str(self.root / 'state')
        self.helper.POLICY = str(self.root / 'policy.json')
        self.helper.IDENTITY = str(self.root / 'identity.json')
        self.helper.installed_baseline = lambda: {'appVersion': '0.3.1', 'packageVersion': '0.3.1', 'architecture': 'arm64'}
        self.private = self.root / 'private.pem'
        self.public = self.root / 'public.pem'
        self.run_tool('/usr/bin/openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(self.private))
        self.run_tool('/usr/bin/openssl', 'pkey', '-in', str(self.private), '-pubout', '-out', str(self.public))
        (self.root / 'policy.json').write_text(json.dumps({'schemaVersion': 1, 'helperProtocol': 1, 'trustedKeys': [self.public.read_text()]}))
        (self.root / 'identity.json').write_text(json.dumps({'schemaVersion': 1, 'packageName': 'shop-things', 'appVersion': '0.3.1'}))
        (self.root / 'policy.json').chmod(0o644)
        (self.root / 'identity.json').chmod(0o644)
        payload = self.root / 'payload'
        (payload / 'DEBIAN').mkdir(parents=True)
        (payload / 'DEBIAN/control').write_text('Package: shop-things\nVersion: 0.4.0-1\nArchitecture: arm64\nMaintainer: Test <noreply@example.com>\nDescription: fixture\n')
        identity = payload / 'opt/Shop Things/resources/update/identity.json'
        identity.parent.mkdir(parents=True)
        identity.write_text(json.dumps({'schemaVersion': 1, 'packageName': 'shop-things', 'appVersion': '0.4.0'}))
        self.artifact = self.root / 'candidate.deb'
        self.run_tool('/usr/bin/dpkg-deb', '--build', '--root-owner-group', str(payload), str(self.artifact))
        self.artifact.chmod(0o600)
        self.manifest = {'schemaVersion': 1, 'applicationId': 'com.shopthings.app', 'repository': 'nsdeschenes/shop-things', 'channel': 'stable', 'appVersion': '0.4.0', 'packageName': 'shop-things', 'packageVersion': '0.4.0-1', 'platform': 'linux', 'architecture': 'arm64', 'helperProtocol': {'min': 1, 'max': 1}, 'artifact': {'filename': 'shop-things-0.4.0-linux-arm64.deb', 'byteLength': self.artifact.stat().st_size, 'sha256': hashlib.sha256(self.artifact.read_bytes()).hexdigest()}}

    def tearDown(self):
        self.temporary.cleanup()

    def run_tool(self, *args):
        return subprocess.run(args, check=True, capture_output=True).stdout

    def request(self):
        manifest = self.root / 'manifest.json'
        manifest.write_bytes(json.dumps(self.manifest).encode())
        signature = self.root / 'signature'
        self.run_tool('/usr/bin/openssl', 'pkeyutl', '-sign', '-rawin', '-inkey', str(self.private), '-in', str(manifest), '-out', str(signature))
        return {'protocol': 1, 'attemptId': 'b7f650aa-0c51-4d68-a940-7f1472b86b46', 'manifest': base64.b64encode(manifest.read_bytes()).decode(), 'signature': base64.b64encode(signature.read_bytes()).decode(), 'candidatePath': str(self.artifact)}

    def test_verified_signed_bytes_are_protected_and_mutation_disabled(self):
        result = self.helper.verify_request(self.request(), os.getuid())
        self.assertEqual(result['outcome'], 'install-disabled')
        self.assertEqual(result['packageVersion'], '0.4.0-1')
        staged = self.root / 'state/b7f650aa-0c51-4d68-a940-7f1472b86b46/artifact.deb'
        self.assertEqual(staged.read_bytes(), self.artifact.read_bytes())
        self.assertEqual(staged.stat().st_mode & 0o777, 0o600)
        self.assertEqual(staged.parent.stat().st_mode & 0o777, 0o700)

    def test_aliased_identity_and_linked_parent_are_rejected(self):
        import io
        import tarfile
        raw = self.run_tool('/usr/bin/dpkg-deb', '--fsys-tarfile', str(self.artifact))
        for alias, linked in [('opt/./Shop Things/resources/update/identity.json', False),
                              ('opt//Shop Things/resources/update', True)]:
            archive = self.root / 'data.tar.gz'
            with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as source, tarfile.open(archive, 'w:gz') as target:
                for member in source:
                    target.addfile(member, source.extractfile(member) if member.isfile() else None)
                member = tarfile.TarInfo(alias)
                if linked:
                    member.type = tarfile.SYMTYPE
                    member.linkname = '/tmp/unsafe'
                    target.addfile(member)
                else:
                    content = b'{"schemaVersion":1,"packageName":"shop-things","appVersion":"9.0.0"}'
                    member.size = len(content)
                    target.addfile(member, io.BytesIO(content))
            candidate = self.root / ('linked.deb' if linked else 'alias.deb')
            candidate.write_bytes(self.artifact.read_bytes())
            names = self.run_tool('/usr/bin/ar', 't', str(candidate)).decode().splitlines()
            for name in names:
                if name.startswith('data.tar'):
                    subprocess.run(['/usr/bin/ar', 'd', str(candidate), name], check=True, capture_output=True)
            subprocess.run(['/usr/bin/ar', 'r', str(candidate), str(archive)], check=True, capture_output=True)
            with self.assertRaises(ValueError):
                self.helper.package_identity(str(candidate))

    def test_wrong_signature_fails_before_candidate_copy(self):
        request = self.request()
        request['signature'] = base64.b64encode(bytes(64)).decode()
        with self.assertRaises(ValueError):
            self.helper.verify_request(request, os.getuid())
        self.assertFalse((self.root / 'state' / request['attemptId'] / 'artifact.deb').exists())

    def test_unknown_protocol_or_caller_options_are_rejected(self):
        for field, value in [('protocol', 2), ('executable', '/bin/true')]:
            request = self.request()
            request[field] = value
            with self.assertRaises(ValueError):
                self.helper.verify_request(request, os.getuid())

    def test_private_policy_key_is_rejected(self):
        policy = self.root / 'policy.json'
        policy.write_text(json.dumps({'schemaVersion': 1, 'helperProtocol': 1, 'trustedKeys': [self.private.read_text()]}))
        with self.assertRaises(ValueError):
            self.helper.verify_request(self.request(), os.getuid())

    def test_signed_wrong_identity_is_rejected(self):
        self.manifest['architecture'] = 'amd64'
        with self.assertRaises(ValueError):
            self.helper.verify_request(self.request(), os.getuid())

    def test_symlink_source_is_rejected(self):
        request = self.request()
        link = self.root / 'link.deb'
        link.symlink_to(self.artifact)
        request['candidatePath'] = str(link)
        with self.assertRaises(OSError):
            self.helper.verify_request(request, os.getuid())

    def test_symlink_parent_and_unsafe_file_modes_are_rejected(self):
        link = self.root / 'parent'
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            self.helper.open_path(str(link / 'candidate.deb'), os.getuid())
        self.artifact.chmod(0o666)
        with self.assertRaises(ValueError):
            self.helper.open_path(str(self.artifact), os.getuid())

    def test_replacement_during_copy_is_rejected(self):
        original = self.helper.os.read
        replaced = False
        artifact_inode = self.artifact.stat().st_ino
        def read(file, size):
            nonlocal replaced
            if os.fstat(file).st_ino == artifact_inode and not replaced:
                self.artifact.rename(self.root / 'old.deb')
                self.artifact.write_bytes(b'replacement')
                self.artifact.chmod(0o600)
                replaced = True
            return original(file, size)
        self.helper.os.read = read
        try:
            with self.assertRaises(ValueError):
                self.helper.verify_request(self.request(), os.getuid())
        finally:
            self.helper.os.read = original

    def test_altered_staged_bytes_and_replay_are_rejected(self):
        request = self.request()
        self.artifact.write_bytes(self.artifact.read_bytes()[:-1] + b'x')
        with self.assertRaises(ValueError):
            self.helper.verify_request(request, os.getuid())
        with self.assertRaises(FileExistsError):
            self.helper.verify_request(request, os.getuid())

    def test_target_app_record_must_match_signed_version(self):
        path = self.root / 'payload/opt/Shop Things/resources/update/identity.json'
        path.write_text(json.dumps({'schemaVersion': 1, 'packageName': 'shop-things', 'appVersion': '0.3.1'}))
        self.run_tool('/usr/bin/dpkg-deb', '--build', '--root-owner-group', str(self.root / 'payload'), str(self.artifact))
        self.manifest['artifact']['byteLength'] = self.artifact.stat().st_size
        self.manifest['artifact']['sha256'] = hashlib.sha256(self.artifact.read_bytes()).hexdigest()
        with self.assertRaises(ValueError):
            self.helper.verify_request(self.request(), os.getuid())

    def test_independent_app_and_debian_versions_must_both_advance(self):
        self.helper.installed_baseline = lambda: {'appVersion': '0.5.0', 'packageVersion': '0.3.1', 'architecture': 'arm64'}
        with self.assertRaises(ValueError):
            self.helper.verify_request(self.request(), os.getuid())

    def test_duplicate_json_and_invalid_utf8_are_rejected(self):
        for value in [b'{"protocol":1,"protocol":1}', b'\xff']:
            with self.assertRaises(ValueError):
                self.helper.strict_json(value)

    def test_target_identity_link_is_not_followed(self):
        path = self.root / 'payload/opt/Shop Things/resources/update/identity.json'
        path.unlink()
        path.symlink_to('/etc/passwd')
        self.run_tool('/usr/bin/dpkg-deb', '--build', '--root-owner-group', str(self.root / 'payload'), str(self.artifact))
        with self.assertRaises(ValueError):
            self.helper.package_identity(str(self.artifact))

    def test_shipped_isolated_entry_refuses_unauthorized_execution(self):
        source = Path(__file__).resolve().parents[1] / 'update/updater-helper.py'
        result = subprocess.run(['/usr/bin/python3', '-I', str(source)], input=json.dumps(self.request()).encode(), capture_output=True, timeout=5)
        self.assertEqual(json.loads(result.stdout)['outcome'], 'rejected')
        self.assertNotIn(str(self.artifact).encode(), result.stdout + result.stderr)
        self.assertFalse((self.root / 'state').exists())


if __name__ == '__main__':
    unittest.main()
