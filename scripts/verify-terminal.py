"""Exercise the packaged default interface through a real pseudo-terminal."""
import errno
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time
import shutil
import sqlite3
import json
import tempfile
from pathlib import Path

launcher = os.path.abspath(sys.argv[1])
fixture = os.path.abspath(sys.argv[2])
scratch = tempfile.TemporaryDirectory(prefix='ctx-pty-')
repository = os.path.join(scratch.name, 'project-from-cwd')
shutil.copytree(fixture, repository, ignore=shutil.ignore_patterns('.harness', '.git', 'node_modules'))
subprocess.run(['git', 'init', '-q', '-b', 'ctx-smoke', repository], check=True)
exit_mode = sys.argv[3] if len(sys.argv) > 3 else 'quit'
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
original = termios.tcgetattr(slave)
child = subprocess.Popen([launcher], cwd=repository, stdin=slave, stdout=slave,
                         stderr=slave, env={**os.environ, 'TERM': 'xterm-256color'})
output = bytearray()
visible_width, visible_height = 110, 30

def screen():
    # Reconstruct absolute-position cell updates; searching raw bytes misses
    # text whose unchanged cells were omitted by the terminal renderer.
    rows = [[' '] * 110 for _ in range(30)]
    row = col = 0
    saved = (0, 0)
    tokens = re.finditer(r'\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|P[\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~]|.)|[^\x1b]', output.decode('utf-8', errors='replace'))
    for match in tokens:
        token = match.group()
        if token.startswith('\x1b['):
            op = token[-1]
            value = token[2:-1]
            if value.startswith('?') or op == 'm':
                continue
            parts = [int(part or '0') for part in value.split(';') if part.isdigit() or not part]
            n = parts[0] if parts else 0
            if op in ('H', 'f'):
                row, col = max(0, n - 1), max(0, (parts[1] if len(parts) > 1 else 1) - 1)
            elif op == 'G': col = max(0, n - 1)
            elif op == 'A': row = max(0, row - (n or 1))
            elif op == 'B': row += n or 1
            elif op == 'C': col += n or 1
            elif op == 'D': col = max(0, col - (n or 1))
            elif op == 'J' and n == 2: rows = [[' '] * 110 for _ in range(30)]
            elif op == 'K' and row < 30:
                for index in range(col if n == 0 else 0, 110 if n != 1 else min(col + 1, 110)):
                    rows[row][index] = ' '
        elif token == '\x1b7': saved = (row, col)
        elif token == '\x1b8': row, col = saved
        elif token.startswith('\x1b'):
            continue
        elif token == '\r': col = 0
        elif token == '\n': row += 1
        elif token >= ' ':
            if row < 30 and col < 110: rows[row][col] = token
            col += 1
    return '\n'.join(''.join(line[:visible_width]) for line in rows[:visible_height])


def wait_for(text, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if text in screen():
            return
        if select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            output.extend(data)
        if child.poll() is not None:
            break
    raise AssertionError(f'Missing terminal output {text!r}:\n{screen()}')

def send(command):
    os.write(master, command.encode() + b'\r')


def drain():
    while select.select([master], [], [], 0.05)[0]:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data: break
        output.extend(data)


def wait_exit():
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        drain()
        if child.poll() is not None: return child.returncode
        time.sleep(0.02)
    raise AssertionError(f'CTX did not exit:\n{screen()}')


def close_overlay():
    os.write(master, b'\x1b')
    time.sleep(0.1)
    drain()


def evidence(name):
    target = os.environ.get('CTX_SMOKE_EVIDENCE')
    if target:
        Path(target).mkdir(parents=True, exist_ok=True)
        Path(target, name + '.txt').write_text(screen())


try:
    wait_for('CTX  Minimal')
    wait_for('Message CTX')
    wait_for('project-from-cwd')
    wait_for('ctx-smoke')
    assert b'\x1b[?1049h' in output, 'Native alternate-screen renderer did not start'
    assert b'ctx >' not in output and 'ctx ›'.encode() not in output
    assert b'Your local engineering workspace' not in output, 'Legacy printed welcome is still rendered'
    evidence('minimal')
    send('/help'); wait_for('Help · Esc close'); wait_for('Commands:'); close_overlay()
    send('/tasks'); wait_for('No tasks yet.')
    send('/status'); wait_for('No saved task found.')
    live = os.environ.get('CTX_PTY_LIVE') == '1'
    if live:
        send('hello can you make a folder')
        wait_for('Completed', 180)
    else:
        # Cancel a real multiline request before spending a model turn.
        os.write(master, b'PTY acceptance first line\nsecond line\r/cancel\r')
        wait_for('CANCELLED')
    with sqlite3.connect(os.path.join(repository, '.harness', 'harness.sqlite')) as database:
        tasks = [json.loads(row[0]) for row in database.execute('SELECT data FROM tasks')]
        event_types = [row[0] for row in database.execute('SELECT type FROM events')]
    assert len(tasks) == 1, tasks
    task = tasks[0]
    if live:
        assert task['status'] == 'completed' and task['report']['execution']['codexStarted'], task
        assert Path(task['workspacePath'], 'new-folder').is_dir()
        assert not Path(repository, 'new-folder').exists()
        for name in ['codex.session.started', 'codex.turn.started', 'codex.tool.started', 'codex.tool.completed', 'codex.turn.completed', 'verification.started', 'verification.completed']:
            assert name in event_types, name
        evidence('live-completed')
        target = os.environ.get('CTX_SMOKE_EVIDENCE')
        if target:
            Path(target, 'live-report.json').write_text(json.dumps(task['report'], indent=2))
            Path(target, 'live-events.jsonl').write_text(Path(task['directory'], 'events.jsonl').read_text())
            shutil.copytree(task['directory'], Path(target, 'task-evidence'), dirs_exist_ok=True)
    else:
        assert task['request'] == 'PTY acceptance first line\nsecond line', tasks
        assert task['status'] == 'cancelled' and not task['attempts'], 'PTY smoke must cancel before spending a model turn'
    send('/tasks'); wait_for(task['status'])
    send('/status'); wait_for('Completed' if live else task['status'].upper())
    os.write(master, b'\t'); wait_for('CTX  Detailed'); wait_for('TASK PLAN'); evidence('detailed')
    # Palette keyboard navigation and focus restoration.
    os.write(master, b'\x10'); wait_for('Command palette')
    os.write(master, b'config\r'); wait_for('Launched from:'); wait_for('Security scans are explicit')
    # Live resize while a draft exists; modes retain both the draft and history.
    os.write(master, b'unsent draft')
    visible_width, visible_height = 48, 18
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 18, 48, 0, 0))
    os.kill(child.pid, __import__('signal').SIGWINCH)
    time.sleep(0.25); drain(); wait_for('Message CTX'); wait_for('unsent draft'); evidence('narrow')
    visible_width, visible_height = 110, 30
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
    os.kill(child.pid, __import__('signal').SIGWINCH)
    time.sleep(0.25); drain()
    os.write(master, b'\t'); wait_for('CTX  Minimal'); wait_for('unsent draft')
    os.write(master, b'\t'); wait_for('CTX  Detailed')
    # Ctrl-U clears the current draft line without submitting it.
    os.write(master, b'\x15')
    if exit_mode == 'interrupt': os.write(master, b'\x03')
    elif exit_mode == 'terminate': child.terminate()
    else: send('/quit')
    assert wait_exit() == 0, screen()
    drain()
    assert b'\x1b[?1049l' in output, 'Alternate screen was not restored'
    assert termios.tcgetattr(slave) == original, 'Terminal settings were not restored'
    # Start the actual executable again to check durable mode preference.
    output.clear()
    child = subprocess.Popen([launcher], cwd=repository, stdin=slave, stdout=slave, stderr=slave,
                             env={**os.environ, 'TERM': 'xterm-256color'})
    wait_for('CTX  Detailed'); send('/quit'); assert wait_exit() == 0
    drain(); assert termios.tcgetattr(slave) == original
    task_path = 'real Codex folder acceptance' if live else 'multiline submission and cancellation'
    print(f'OpenTUI PTY verified: cwd repository, {task_path}, tasks/status/help, palette, both modes, persisted preference, resizing, {exit_mode} exit and terminal restoration.')
finally:
    if child.poll() is None:
        child.kill(); child.wait()
    os.close(master); os.close(slave)
    scratch.cleanup()
