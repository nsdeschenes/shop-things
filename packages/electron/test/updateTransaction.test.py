import importlib.util
from pathlib import Path
import unittest
import sys
sys.dont_write_bytecode = True

class ActualTransaction(unittest.TestCase):
    def test_protocol_three_preserves_all_ordered_archives_and_rejects_fallback(self):
        spec = importlib.util.spec_from_file_location('transaction', Path(__file__).parents[1] / 'update/transaction.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        rows = module.parse_plan(b'VERSION 3\nAPT::Architecture=arm64\n\nshop-things 1 arm64 none < 2 arm64 none /protected/app.deb\ndep - - none < 1 all none /protected/dep.deb\ndep 1 all none = 1 all none **CONFIGURE**\n')
        self.assertEqual([row['package'] for row in rows], ['shop-things', 'dep', 'dep'])
        self.assertEqual(rows[1]['newArchitecture'], 'all')
        with self.assertRaises(ValueError):
            module.parse_plan(b'VERSION 2\n\n')

    def test_fallback_unknown_action_and_truncated_protocol_are_rejected(self):
        spec = importlib.util.spec_from_file_location('transaction', Path(__file__).parents[1] / 'update/transaction.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for raw in [b'VERSION 3\nAPT::Architecture=arm64\n',
                    b'VERSION 3\n\napp 1 arm64 no < 2 arm64 no **ERROR**\n',
                    b'VERSION 3\n\napp 1 arm64 no < 2 arm64 no\n']:
            with self.assertRaises(ValueError):
                module.parse_plan(raw)

    def test_effective_binary_policy_and_extra_hooks_cannot_bypass_actual_gate(self):
        spec = importlib.util.spec_from_file_location('transaction', Path(__file__).parents[1] / 'update/transaction.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        action = b'shop-things 1 arm64 none < 2 arm64 none /protected/app.deb\n'
        for config in [b'Binary::apt-get::APT::Get::AllowUnauthenticated=true',
                       b'dpkg::options::=--force-overwrite', b'Debug::NoLocking=1',
                       b'DPkg::Pre-Install-Pkgs::=/caller/hook']:
            with self.assertRaises(ValueError):
                module.parse_plan(b'VERSION 3\n' + config + b'\n\n' + action)

    def test_bounded_unchanged_reason_distinguishes_real_dpkg_lock_from_other_rejection(self):
        spec = importlib.util.spec_from_file_location('transaction', Path(__file__).parents[1] / 'update/transaction.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.unchanged_error(b'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 123'), 'PACKAGE_LOCK')
        self.assertEqual(module.unchanged_error(b'E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?'), 'PACKAGE_LOCK')
        self.assertEqual(module.unchanged_error(b'E: Actual downgrade rejected'), 'TRANSACTION_REJECTED')

if __name__ == '__main__':
    unittest.main()
