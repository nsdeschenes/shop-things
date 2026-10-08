"""Controlled process-boundary fixtures; no privileged or GTK desktop proof."""
import importlib.util
import pathlib
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

source = pathlib.Path(__file__).parent.parent / 'update' / 'restart-supervisor.py'
# Test-only packaged acceptance entry; production supervisor has no policy override.
import sys
sys.dont_write_bytecode = True
if len(sys.argv) == 3 and sys.argv[1] == '--packaged-source':
    source = pathlib.Path(sys.argv[2])
    sys.argv = [sys.argv[0]]
spec = importlib.util.spec_from_file_location('restart_supervisor', source)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)

class SupervisorTests(unittest.TestCase):
    def test_original_process_identity_cannot_match_reused_pid(self):
        policy=supervisor.Policy()
        identity=supervisor.process_identity(os.getpid())
        self.assertTrue(policy.old_alive({'oldPid':os.getpid(),'oldStart':identity}))
        self.assertFalse(policy.old_alive({'oldPid':os.getpid(),'oldStart':'0'}))
        self.assertFalse(policy.old_alive({'oldPid':2147483647,'oldStart':identity}))

    def test_production_isolated_entry_rejects_executable_selection(self):
        result = subprocess.run(['/usr/bin/python3','-I',str(source)],input=b'{"protocol":1,"executable":"/bin/true"}\n',capture_output=True,check=False)
        self.assertEqual(result.returncode,1)
        self.assertEqual(json.loads(result.stdout)['type'],'error')

    def test_rejects_caller_selected_executable(self):
        with self.assertRaises(ValueError):
            supervisor.request({'protocol': 1, 'executable': '/bin/true'})


ATTEMPT = 'b7f650aa-0c51-4d68-a940-7f1472b86b46'

class FixturePolicy(supervisor.Policy):
    readiness_timeout = 0.4
    poll_seconds = 0.01

    def __init__(self, behavior='ready'):
        self.behavior = behavior
        self.old_running = True
        self.launches = []
        self.dialogs = []
        self.reject_installed = False
        self.manual = False

    def validate_parent(self, value):
        pass

    def validate_desktop(self):
        pass

    def old_alive(self, value):
        return self.old_running

    def verify_installed(self, receipt):
        if self.reject_installed:
            raise ValueError('dpkg configured target mismatch')

    def notify(self, phase, diagnostics, child_alive):
        self.dialogs.append((phase, child_alive))
        return self.manual

    def launch(self, environment):
        if self.behavior == 'failure':
            raise OSError('launch fixture failed')
        # Fixtures replace only the fixed executable boundary, never production input.
        script = r"""
import json,os,socket,time
behavior = os.environ['FIXTURE_BEHAVIOR']
if behavior in ('ready', 'wrong-token'):
    connection = socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    connection.connect(os.environ['SHOP_THINGS_RESTART_SOCKET'])
    value={'protocol':1,'type':'ready','attemptId':os.environ['SHOP_THINGS_RESTART_ATTEMPT'],'token':os.environ['SHOP_THINGS_RESTART_TOKEN']}
    if behavior == 'wrong-token': value['token']='0'*64
    connection.sendall(json.dumps(value).encode()+b'\n')
    if behavior == 'ready':
        assert json.loads(connection.recv(1024)) == {'protocol':1,'type':'acknowledged'}
    connection.close()
if behavior != 'exit': time.sleep(2)
"""
        environment['FIXTURE_BEHAVIOR'] = self.behavior
        child = subprocess.Popen(['/usr/bin/python3', '-I', '-c', script], env=environment)
        self.launches.append(child)
        if self.behavior == 'impostor':
            def impostor():
                time.sleep(0.03)
                connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                connection.connect(environment['SHOP_THINGS_RESTART_SOCKET'])
                connection.sendall(json.dumps({'protocol':1,'type':'ready','attemptId':ATTEMPT,'token':environment['SHOP_THINGS_RESTART_TOKEN']}).encode()+b'\n')
                connection.close()
            threading.Thread(target=impostor).start()
        return child

class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        os.chmod(self.temporary.name, 0o700)
        self.policy = FixturePolicy()
        self.value = {'protocol':1,'attemptId':ATTEMPT,'oldPid':os.getpid(),'oldStart':'1','updatesDirectory':self.temporary.name}
        self.instance = None

    def tearDown(self):
        for child in self.policy.launches:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=2)
        self.temporary.cleanup()

    def receipt(self):
        return {'schemaVersion':1,'attemptId':ATTEMPT,'outcome':'installed','manifestDigest':'a'*64,'appVersion':'0.4.0','packageName':'shop-things','packageVersion':'0.4.0-1','architecture':'arm64'}

    def start(self, receipt=True):
        self.instance = supervisor.Supervisor(self.value, self.policy)
        if receipt:
            supervisor.durable_json(os.path.join(self.instance.directory,'install.json'), self.receipt())
        self.policy.old_running = False
        self.instance.run()
        with open(self.instance.record_path, encoding='utf-8') as stream:
            return json.load(stream)

    def test_waits_for_old_exit_and_acknowledges_one_real_child(self):
        self.instance = supervisor.Supervisor(self.value, self.policy)
        supervisor.durable_json(os.path.join(self.instance.directory,'install.json'), self.receipt())
        ready = threading.Event()
        thread = threading.Thread(target=lambda:self.instance.run(lambda value:ready.set()))
        thread.start()
        self.assertTrue(ready.wait(1))
        time.sleep(0.04)
        self.assertEqual(len(self.policy.launches),0)
        self.policy.old_running = False
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        with open(self.instance.record_path, encoding='utf-8') as stream:
            record=json.load(stream)
        self.assertEqual(record['phase'],'ready')
        self.assertEqual(record['installOutcome'],'installed')
        self.assertEqual(len(self.policy.launches),1)
        self.assertEqual(self.policy.dialogs,[])
        self.assertEqual(os.stat(self.instance.record_path).st_mode & 0o777,0o600)

    def test_alive_slow_child_is_never_duplicated(self):
        self.policy.behavior='slow'
        record=self.start()
        self.assertEqual(record['phase'],'launch-slow')
        self.assertEqual(record['installOutcome'],'installed')
        self.assertEqual(self.policy.dialogs,[('launch-slow',True)])
        self.assertEqual(len(self.policy.launches),1)

    def test_recovery_action_never_duplicates_alive_child(self):
        self.policy.behavior='slow'
        self.policy.manual=True
        self.assertEqual(self.start()['phase'],'launch-slow')
        self.assertEqual(len(self.policy.launches),1)

    def test_recovery_action_launches_fixed_fixture_once_after_exit(self):
        self.policy.behavior='exit'
        self.policy.manual=True
        self.assertEqual(self.start()['phase'],'manual-launch-started')
        self.assertEqual(len(self.policy.launches),2)

    def test_wrong_readiness_token_cannot_claim_success(self):
        self.policy.behavior='wrong-token'
        self.assertEqual(self.start()['phase'],'launch-slow')
        self.assertEqual(len(self.policy.launches),1)

    def test_child_exit_distinguishes_install_and_launch_outcomes(self):
        self.policy.behavior='exit'
        record=self.start()
        self.assertEqual(record['phase'],'launch-exited')
        self.assertEqual(record['installOutcome'],'installed')
        self.assertEqual(self.policy.dialogs,[('launch-exited',False)])

    def test_launch_failure_keeps_verified_install_diagnostics(self):
        self.policy.behavior='failure'
        record=self.start()
        self.assertEqual(record['phase'],'launch-failed')
        self.assertEqual(record['installOutcome'],'installed')
        self.assertIn('launch fixture failed',record['diagnostics'])

    def test_missing_receipt_or_changed_dpkg_never_launches(self):
        record=self.start(receipt=False)
        self.assertEqual(record['phase'],'install-unverified')
        self.assertEqual(self.policy.launches,[])

    def test_changed_dpkg_never_launches(self):
        self.policy.reject_installed=True
        self.assertEqual(self.start()['phase'],'install-unverified')
        self.assertEqual(self.policy.launches,[])

    def test_attempt_cannot_launch_twice_after_supervisor_loss(self):
        self.assertEqual(self.start()['phase'],'ready')
        with self.assertRaises(FileExistsError):
            supervisor.Supervisor(self.value,self.policy)
        self.assertEqual(len(self.policy.launches),1)

    def test_other_process_cannot_claim_child_readiness(self):
        self.policy.behavior='impostor'
        self.assertEqual(self.start()['phase'],'launch-slow')

    def test_root_cannot_construct_supervisor(self):
        with patch.object(os, 'getuid', return_value=0):
            with self.assertRaisesRegex(ValueError,'cannot run as root'):
                supervisor.Supervisor(self.value,self.policy)

    def test_corrupt_and_incomplete_receipts_are_not_install_success(self):
        for receipt in ({'outcome':'installed'}, {**self.receipt(),'attemptId':'stale'}, {**self.receipt(),'architecture':'amd64'}):
            with self.assertRaises(ValueError):
                supervisor.verify_receipt(receipt,ATTEMPT)
        with self.assertRaises(ValueError):
            supervisor.strict_json(b'{"protocol":1,"protocol":1}')

    def test_desktop_environment_is_retained_without_runtime_injection(self):
        self.instance=supervisor.Supervisor(self.value,self.policy)
        os.environ['DISPLAY']=':fixture'
        os.environ['ELECTRON_RUN_AS_NODE']='1'
        os.environ['PYTHONPATH']='/unsafe'
        environment=self.instance.environment()
        self.assertEqual(environment['DISPLAY'],':fixture')
        self.assertNotIn('ELECTRON_RUN_AS_NODE',environment)
        self.assertNotIn('PYTHONPATH',environment)
        self.policy.old_running=False
        self.instance.run()

if __name__ == '__main__':
    unittest.main()
