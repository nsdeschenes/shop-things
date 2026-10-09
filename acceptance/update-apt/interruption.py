"""External process observer only. No packaged switches or host package operations.
PTRACE_EVENT_EXEC stops before the selected program executes its first instruction.
"""
import ctypes
import os
from pathlib import Path
import signal
import tempfile
import time

libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.restype = ctypes.c_long
TRACEME, CONT, SETOPTIONS, GETEVENTMSG = 0, 7, 0x4200, 0x4201
TRACEFORK, TRACEVFORK, TRACECLONE, TRACEEXEC = 2, 4, 8, 16
WALL = 0x40000000

def ptrace(operation, pid, data=0):
    result = libc.ptrace(ctypes.c_int(operation), ctypes.c_int(pid), ctypes.c_void_p(0), ctypes.c_void_p(data))
    if result == -1:
        raise OSError(ctypes.get_errno(), 'Controlled process observer failed')
    return result

def start(pid):
    return Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()[19]

def traced_process(args, raw, env, choose, on_cut=None):
    observed = []
    cut = None
    root_code = None
    with tempfile.TemporaryFile() as incoming, tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
        incoming.write(raw)
        incoming.seek(0)
        root = os.fork()
        if root == 0:
            try:
                os.dup2(incoming.fileno(), 0)
                os.dup2(output.fileno(), 1)
                os.dup2(error.fileno(), 2)
                ptrace(TRACEME, 0)
                os.kill(os.getpid(), signal.SIGSTOP)
                os.execve(args[0], args, env)
            except Exception:
                os._exit(126)
        traced = {root}
        deadline = time.monotonic() + 120
        try:
            pid, status = os.waitpid(root, 0)
            if not os.WIFSTOPPED(status):
                raise RuntimeError('External process tracing is unavailable')
            ptrace(SETOPTIONS, root, TRACEFORK | TRACEVFORK | TRACECLONE | TRACEEXEC)
            ptrace(CONT, root)
            while traced:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Controlled process trace did not drain')
                pid, status = os.waitpid(-1, WALL | os.WNOHANG)
                if pid == 0:
                    time.sleep(0.001)
                    continue
                if pid not in traced:
                    raise RuntimeError('Unexpected process outside observer ownership')
                if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                    traced.remove(pid)
                    if pid == root:
                        root_code = os.waitstatus_to_exitcode(status)
                    continue
                event = status >> 16
                if event in (1, 2, 3):
                    child = ctypes.c_ulong()
                    libc.ptrace(ctypes.c_int(GETEVENTMSG), ctypes.c_int(pid), ctypes.c_void_p(0), ctypes.byref(child))
                    if child.value < 2:
                        raise RuntimeError('Missing traced child identity')
                    traced.add(child.value)
                if event == 4:
                    command = Path('/proc/' + str(pid) + '/cmdline').read_bytes()
                    if len(command) > 8192:
                        raise ValueError('Excessive controlled process arguments')
                    command = [part.decode() for part in command.split(b'\0') if part]
                    item = {'pid': pid, 'start': start(pid), 'command': command, 'event': 'exec-before-first-instruction'}
                    if len(observed) >= 1024:
                        raise ValueError('Excessive controlled process events')
                    observed.append(item)
                    selected = choose(root, pid, command) if cut is None else None
                    if selected is not None:
                        cut = {**item, 'killedPid': selected, 'killedStart': start(selected)}
                        os.kill(selected, signal.SIGKILL)
                        if on_cut:
                            on_cut(cut)
                        if selected == pid:
                            continue
                delivered = os.WSTOPSIG(status)
                if event or delivered in (signal.SIGTRAP, signal.SIGSTOP):
                    delivered = 0
                ptrace(CONT, pid, delivered)
        finally:
            for pid in traced:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for pid in traced:
                try:
                    os.waitpid(pid, WALL)
                except ChildProcessError:
                    pass
        if cut is None:
            raise RuntimeError('Requested executable cut was not reached')
        if output.tell() > 8192 or error.tell() > 8192:
            raise ValueError('Controlled helper diagnostics exceeded bounds')
        output.seek(0)
        error.seek(0)
        return {'returncode': root_code, 'stdout': output.read(), 'stderr': error.read(), 'cut': cut,
                'observedProcesses': len(observed), 'limits': 'Process kill at exec stop; no power-loss or graphical authentication proof.'}
