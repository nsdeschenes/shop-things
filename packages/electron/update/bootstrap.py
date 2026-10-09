#!/usr/bin/python3 -I
"""Install fixed package resources; no legacy removal or user-data changes."""
import importlib.util
import os
from pathlib import Path
import stat

SOURCE = Path('/opt/Shop Things/resources/update')
require = lambda value: None if value else (_ for _ in ()).throw(ValueError('Unsafe bootstrap installation'))
require(os.geteuid() == 0)
for parent in [Path('/opt'), Path('/opt/Shop Things'), SOURCE.parent, SOURCE]:
    info = parent.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
helper_path = SOURCE / 'updater-helper.py'
info = helper_path.lstat()
require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
spec = importlib.util.spec_from_file_location('helper', helper_path)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.identity(helper.protected_bytes(str(SOURCE / 'identity.json'), 4096))
for directory in ['/usr/lib/shop-things', '/usr/lib/shop-things/update', '/usr/share/polkit-1/actions']:
    for parent in reversed(Path(directory).parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    if not Path(directory).exists():
        os.mkdir(directory, 0o755)
    info = Path(directory).lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
for source, destination, mode in [
    ('updater-helper.py', '/usr/lib/shop-things/updater-helper', 0o755),
    ('restart-supervisor.py', '/usr/lib/shop-things/update-supervisor', 0o755),
    ('identity.json', '/usr/lib/shop-things/update/identity.json', 0o644),
    ('com.shopthings.app.update.policy', '/usr/share/polkit-1/actions/com.shopthings.app.update.policy', 0o644),
    ('policy.json', '/usr/lib/shop-things/update/policy.json', 0o644),
]:
    if source == 'policy.json' and not (SOURCE / source).exists():
        # Ordinary drafts remain incapable; never reuse stale trust or fabricate a key.
        Path(destination).unlink(missing_ok=True)
        continue
    payload = helper.protected_bytes(str(SOURCE / source), 1048576)
    temporary = destination + '.new'
    file = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(file, mode)
        with os.fdopen(file, 'wb', closefd=False) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(file)
    finally:
        os.close(file)
    os.replace(temporary, destination)
    helper.sync_directory(str(Path(destination).parent))
