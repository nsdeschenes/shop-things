#!/usr/bin/python3 -I
"""Normal-user restart supervisor. No package mutation or executable selection."""
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time

EXECUTABLE = '/opt/Shop Things/shop-things'
LIMIT = 8192
ATTEMPT = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate field')
            result[key] = value
        return result
    if len(raw) > LIMIT:
        raise ValueError('Protocol limit exceeded')
    return json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=pairs)


def request(value):
    if not isinstance(value, dict) or set(value) != {'protocol', 'attemptId', 'oldPid', 'oldStart', 'updatesDirectory'}:
        raise ValueError('Unsupported supervisor request')
    if value['protocol'] != 1 or isinstance(value['protocol'], bool):
        raise ValueError('Unsupported supervisor protocol')
    if not isinstance(value['attemptId'], str) or not ATTEMPT.fullmatch(value['attemptId']):
        raise ValueError('Invalid attempt identity')
    if type(value['oldPid']) is not int or value['oldPid'] < 2:
        raise ValueError('Invalid old process')
    if not isinstance(value['oldStart'], str) or not re.fullmatch(r'[0-9]{1,24}', value['oldStart']):
        raise ValueError('Invalid process identity')
    directory = value['updatesDirectory']
    if not isinstance(directory, str) or not os.path.isabs(directory) or len(directory) > 4096:
        raise ValueError('Invalid diagnostics directory')
    return value


def process_identity(pid):
    try:
        with open('/proc/' + str(pid) + '/stat', encoding='ascii') as stream:
            fields = stream.read(LIMIT).rsplit(')', 1)[1].split()
        return fields[19] if fields[0] != 'Z' else None
    except (FileNotFoundError, ProcessLookupError):
        return None


def private_directory(path):
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Diagnostics directory must be private and owned by this user')


def read_private_json(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Unsafe install receipt')
        return strict_json(stream.read(LIMIT + 1))


def durable_json(path, value):
    temporary = path + '.' + secrets.token_hex(12)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(json.dumps(value, separators=(',', ':')).encode('utf-8'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def verify_receipt(value, attempt):
    keys = {'schemaVersion', 'attemptId', 'outcome', 'manifestDigest', 'appVersion', 'packageName', 'packageVersion', 'architecture'}
    if not isinstance(value, dict) or set(value) != keys or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        raise ValueError('Incomplete verified installation receipt')
    if value['attemptId'] != attempt or value['outcome'] != 'installed' or value['packageName'] != 'shop-things' or value['architecture'] != 'arm64':
        raise ValueError('Installation is not verified')
    if not isinstance(value['manifestDigest'], str) or not re.fullmatch(r'[0-9a-f]{64}', value['manifestDigest']):
        raise ValueError('Invalid manifest digest')
    if not isinstance(value['appVersion'], str) or len(value['appVersion']) > 128 or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?', value['appVersion']):
        raise ValueError('Invalid application version')
    if not isinstance(value['packageVersion'], str) or not re.fullmatch(r'[0-9][0-9A-Za-z.+:~\-]{0,127}', value['packageVersion']):
        raise ValueError('Invalid package version')
    return value


class Policy:
    readiness_timeout = 120
    poll_seconds = 0.1

    def validate_parent(self, value):
        if value['oldPid'] != os.getppid() or process_identity(value['oldPid']) != value['oldStart']:
            raise ValueError('Supervisor must be started by the original application')

    def validate_desktop(self):
        import gi
        gi.require_version('Gtk', '3.0')
        from gi.repository import Gtk
        if not Gtk.init_check()[0]:
            raise ValueError('A GTK3 desktop session is required for restart recovery')

    def old_alive(self, value):
        return process_identity(value['oldPid']) == value['oldStart']

    def install_receipt(self, directory, attempt):
        import importlib.util
        path = Path('/usr/lib/shop-things/update/transaction.py')
        for item in [path, *path.parents]:
            info = item.lstat()
            if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
                raise ValueError('Unsafe protected reconciliation module')
        spec = importlib.util.spec_from_file_location('transaction', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        evidence = module.inspect(os.getuid(), attempt)
        if evidence['outcome'] != 'installed' or not evidence['receipt']:
            raise ValueError('Protected relevant package installation is not confirmed')
        root = evidence['receipt']
        return {'schemaVersion': 1, 'attemptId': attempt, 'outcome': 'installed',
                'manifestDigest': root['manifestDigest'], 'appVersion': root['appVersion'],
                'packageName': 'shop-things', 'packageVersion': root['packageVersion'], 'architecture': 'arm64'}

    def verify_installed(self, receipt):
        protected = self.install_receipt(None, receipt['attemptId'])
        if protected != receipt:
            raise ValueError('Protected receipt identity changed')
        result = subprocess.run(['/usr/bin/dpkg-query', '--admindir=/var/lib/dpkg', '-W', '-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n', 'shop-things'], check=True, capture_output=True, timeout=10, env={'PATH':'/usr/bin:/bin','LC_ALL':'C','LANG':'C'})
        expected = 'shop-things\t' + receipt['packageVersion'] + '\tarm64\tinstalled\n'
        if result.stdout.decode('utf-8', errors='strict') != expected:
            raise ValueError('The intended package is not configured')
        owner = subprocess.run(['/usr/bin/dpkg-query', '--admindir=/var/lib/dpkg', '-S', EXECUTABLE], check=True, capture_output=True, timeout=10, env={'PATH':'/usr/bin:/bin','LC_ALL':'C','LANG':'C'})
        if owner.stdout.decode('utf-8', errors='strict') != 'shop-things: ' + EXECUTABLE + '\n':
            raise ValueError('The fixed executable is not owned by shop-things')
        for path in ('/opt', '/opt/Shop Things', EXECUTABLE):
            info = os.lstat(path)
            if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
                raise ValueError('The fixed executable policy is unsafe')
        if not stat.S_ISREG(os.lstat(EXECUTABLE).st_mode):
            raise ValueError('The fixed executable is unavailable')

    def launch(self, environment):
        return subprocess.Popen([EXECUTABLE], env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)

    def notify(self, phase, diagnostics, child_alive):
        # GTK is required by bootstrap; failure leaves the durable record available.
        import gi
        gi.require_version('Gtk', '3.0')
        from gi.repository import Gtk
        if not Gtk.init_check()[0]:
            raise RuntimeError('Desktop session unavailable')
        message = ('Shop Things is still starting.' if child_alive else
                   'Shop Things was installed, but could not start.' if phase in ('launch-failed', 'launch-exited') else
                   'Shop Things could not verify this update.')
        dialog = Gtk.MessageDialog(message_type=Gtk.MessageType.WARNING, buttons=Gtk.ButtonsType.NONE, text=message)
        dialog.format_secondary_text(('An application is already running. Wait before launching another copy.\n' if child_alive else '') + 'Diagnostics: ' + diagnostics)
        dialog.add_button('Close', Gtk.ResponseType.CLOSE)
        if not child_alive and phase in ('launch-failed', 'launch-exited'):
            dialog.add_button('Launch Shop Things', Gtk.ResponseType.ACCEPT)
        dialog.set_default_response(Gtk.ResponseType.CLOSE)
        response = dialog.run()
        dialog.destroy()
        return response == Gtk.ResponseType.ACCEPT and not child_alive


class Supervisor:
    def __init__(self, value, policy=None):
        if os.getuid() == 0 or os.geteuid() == 0:
            raise ValueError('The supervisor cannot run as root')
        self.value = request(value)
        self.policy = policy or Policy()
        self.policy.validate_parent(self.value)
        self.policy.validate_desktop()
        private_directory(self.value['updatesDirectory'])
        self.directory = os.path.join(self.value['updatesDirectory'], self.value['attemptId'])
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        private_directory(self.directory)
        # Exclusive admission survives supervisor/session loss; an attempt is never replayed.
        lock = os.open(os.path.join(self.directory, 'supervisor.lock'), os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.fsync(lock)
        os.close(lock)
        for directory in (self.directory, self.value['updatesDirectory']):
            parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        self.record_path = os.path.join(self.directory, 'launch.json')
        self.runtime = tempfile.mkdtemp(prefix='shop-things-restart-', dir='/tmp')
        self.socket_path = os.path.join(self.runtime, 'ready.sock')
        self.token = secrets.token_hex(32)
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.bind(self.socket_path)
        os.chmod(self.socket_path, 0o600)
        self.socket.listen(4)
        self.socket.settimeout(self.policy.poll_seconds)
        self.receipt = None
        self.child_identity = None
        self.record('waiting-for-old-exit')

    def record(self, phase, diagnostics=''):
        durable_json(self.record_path, {'schemaVersion': 1, 'attemptId': self.value['attemptId'], 'phase': phase, 'installOutcome': 'installed' if self.receipt else 'unverified', 'diagnostics': diagnostics[:1024], 'updatedAt': int(time.time()), 'child': self.child_identity})

    def environment(self):
        environment = dict(os.environ)
        for name in list(environment):
            if name.startswith(('LD_', 'DYLD_', 'PYTHON')) or name in ('NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL'):
                environment.pop(name)
        environment.update({'SHOP_THINGS_RESTART_SOCKET': self.socket_path, 'SHOP_THINGS_RESTART_TOKEN': self.token, 'SHOP_THINGS_RESTART_ATTEMPT': self.value['attemptId']})
        return environment

    def readiness(self, child):
        try:
            connection, _ = self.socket.accept()
        except socket.timeout:
            return False
        with connection:
            connection.settimeout(1)
            pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid() or pid != child.pid:
                return False
            raw = b''
            while len(raw) <= LIMIT and not raw.endswith(b'\n'):
                chunk = connection.recv(1024)
                if not chunk:
                    return False
                raw += chunk
            try:
                value = strict_json(raw)
            except (ValueError, UnicodeError):
                return False
            if not isinstance(value, dict) or type(value.get('protocol')) is not int or value != {'protocol': 1, 'attemptId': self.value['attemptId'], 'token': self.token, 'type': 'ready'}:
                return False
            self.record('ready')
            connection.sendall(b'{"protocol":1,"type":"acknowledged"}\n')
            return True

    def failure(self, phase, error='', child=None):
        self.record(phase, error)
        alive = child is not None and child.poll() is None
        try:
            manual = self.policy.notify(phase, self.record_path, alive)
            # Never duplicate a live automatic child, even if it exits during the dialog.
            if manual and not alive and phase in ('launch-failed', 'launch-exited'):
                self.policy.verify_installed(self.receipt)
                self.record('manual-launch-intent')
                environment = self.environment()
                for name in ('SHOP_THINGS_RESTART_SOCKET', 'SHOP_THINGS_RESTART_TOKEN', 'SHOP_THINGS_RESTART_ATTEMPT'):
                    environment.pop(name, None)
                manual_child = self.policy.launch(environment)
                self.child_identity = {'pid': manual_child.pid, 'start': process_identity(manual_child.pid)}
                self.record('manual-launch-started')
        except Exception as notification_error:
            self.record(phase, error + '; notification: ' + str(notification_error))

    def run(self, ready=None):
        try:
            if ready:
                ready({'protocol': 1, 'type': 'ready', 'attemptId': self.value['attemptId']})
            while self.policy.old_alive(self.value):
                time.sleep(self.policy.poll_seconds)
            try:
                receipt = self.policy.install_receipt(self.directory, self.value['attemptId'])
                self.receipt = verify_receipt(receipt, self.value['attemptId'])
                self.policy.verify_installed(self.receipt)
            except Exception as error:
                self.receipt = None
                self.failure('install-unverified', str(error))
                return
            self.record('launch-intent')
            try:
                child = self.policy.launch(self.environment())
            except Exception as error:
                self.failure('launch-failed', str(error))
                return
            self.child_identity = {'pid': child.pid, 'start': process_identity(child.pid)}
            self.record('launch-started')
            deadline = time.monotonic() + self.policy.readiness_timeout
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    self.failure('launch-exited', 'exit=' + str(child.returncode), child)
                    return
                if self.readiness(child):
                    return
            if child.poll() is None:
                self.failure('launch-slow', 'No readiness after 120 seconds; existing process is alive.', child)
            else:
                self.failure('launch-exited', 'exit=' + str(child.returncode), child)
        finally:
            self.socket.close()
            shutil.rmtree(self.runtime)


def main():
    raw = sys.stdin.buffer.readline(LIMIT + 1)
    supervisor = Supervisor(strict_json(raw))
    supervisor.run(lambda value: print(json.dumps(value, separators=(',', ':')), flush=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'protocol': 1, 'type': 'error', 'diagnostics': str(error)[:1024]}), flush=True)
        sys.exit(1)
