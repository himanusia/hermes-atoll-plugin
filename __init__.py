"""Native Hermes plugin entry point for the Atoll status monitor."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

MIN_NODE = (22, 5, 0)


def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()


def _plugin_dir() -> Path:
    return Path(__file__).resolve().parent


def _pid_file() -> Path:
    return _hermes_home() / "run" / "hermes-atoll-plugin.pid"


def _read_pid() -> int | None:
    try:
        pid = int(_pid_file().read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    return pid if pid > 1 else None


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _is_monitor_pid(pid: int) -> bool:
    """Avoid signalling an unrelated process if the OS has reused a stale PID."""
    try:
        result = subprocess.run(
            ["/bin/ps", "-p", str(pid), "-o", "command="],
            check=True,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return str(_plugin_dir() / "host.js") in result.stdout


def _node_binary() -> str | None:
    try:
        from hermes_constants import find_node_executable

        return find_node_executable("node") or shutil.which("node")
    except Exception:
        return shutil.which("node")


def _node_version_ok(node: str) -> bool:
    try:
        result = subprocess.run(
            [node, "--version"], check=True, capture_output=True, text=True, timeout=5
        )
    except (OSError, subprocess.SubprocessError):
        return False
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", result.stdout.strip())
    return bool(match and tuple(map(int, match.groups())) >= MIN_NODE)


def _start_monitor() -> int:
    pid_file = _pid_file()
    existing = _read_pid()
    if existing and _pid_alive(existing) and _is_monitor_pid(existing):
        print(f"Hermes Atoll monitor is already running (pid {existing}).")
        return 0

    node = _node_binary()
    if not node or not _node_version_ok(node):
        print("Hermes Atoll needs Node.js 22.5 or newer. Install it, then run `hermes atoll start`.")
        return 1

    package = _plugin_dir() / "node_modules" / "@ebullioscopic" / "atoll-js"
    if not package.is_dir():
        print("Atoll's Node package is missing. Reinstall with `hermes plugins install himanusia/hermes-atoll-plugin` and accept the Node dependency prompt.")
        return 1

    run_dir = pid_file.parent
    log_dir = _hermes_home() / "logs" / "notch"
    run_dir.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "hermes-atoll.log"
    try:
        env = os.environ.copy()
        try:
            from hermes_constants import with_hermes_node_path

            env = with_hermes_node_path(env)
        except Exception:
            pass
        search_paths = ["/opt/homebrew/bin", "/usr/local/bin", str(Path(node).resolve().parent)]
        env["PATH"] = os.pathsep.join(search_paths + [env.get("PATH", "")])
        with log_path.open("a", encoding="utf-8") as log_file:
            process = subprocess.Popen(
                [node, str(_plugin_dir() / "host.js")],
                cwd=_plugin_dir(),
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                close_fds=True,
                start_new_session=True,
                env=env,
            )
    except OSError as exc:
        print(f"Could not start Hermes Atoll monitor: {exc}")
        return 1

    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if process.poll() is not None:
            print(f"Hermes Atoll monitor exited during startup; see {log_path}.")
            return 1
        pid = _read_pid()
        if pid == process.pid:
            print(f"Started Hermes Atoll monitor (pid {pid}).")
            return 0
        time.sleep(0.05)
    print(f"Monitor launch requested; check status with `hermes atoll status` and logs at {log_path}.")
    return 0


def _stop_monitor() -> int:
    pid_file = _pid_file()
    pid = _read_pid()
    if not pid or not _pid_alive(pid) or not _is_monitor_pid(pid):
        try:
            pid_file.unlink()
        except OSError:
            pass
        print("Hermes Atoll monitor is not running.")
        return 0
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as exc:
        print(f"Could not stop Hermes Atoll monitor (pid {pid}): {exc}")
        return 1
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline and _pid_alive(pid):
        time.sleep(0.1)
    if _pid_alive(pid):
        print(f"Monitor (pid {pid}) did not stop; inspect {pid_file}.")
        return 1
    print("Stopped Hermes Atoll monitor.")
    return 0


def _status_monitor() -> int:
    pid = _read_pid()
    if pid and _pid_alive(pid) and _is_monitor_pid(pid):
        print(f"Hermes Atoll monitor is running (pid {pid}).")
    else:
        print("Hermes Atoll monitor is stopped. It starts automatically at the next Hermes session.")
    return 0


def _setup_cli(parser: argparse.ArgumentParser) -> None:
    commands = parser.add_subparsers(dest="atoll_action")
    commands.add_parser("status", help="Show whether the monitor is running")
    commands.add_parser("start", help="Start the monitor now")
    commands.add_parser("stop", help="Stop the monitor until the next Hermes session")
    commands.add_parser("restart", help="Restart the monitor now")
    parser.set_defaults(func=_dispatch_cli)


def _dispatch_cli(args: argparse.Namespace) -> int:
    action = getattr(args, "atoll_action", None) or "status"
    if action == "start":
        return _start_monitor()
    if action == "stop":
        return _stop_monitor()
    if action == "restart":
        if _stop_monitor():
            return 1
        return _start_monitor()
    return _status_monitor()


def _on_session_start(**_kwargs: Any) -> None:
    """Start one detached monitor; the host lock prevents duplicate displays."""
    _start_monitor()


def register(ctx: Any) -> None:
    """Register the Hermes session hook and ``hermes atoll`` controls."""
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_cli_command(
        name="atoll",
        help="Control the Hermes Atoll notch monitor",
        setup_fn=_setup_cli,
        handler_fn=_dispatch_cli,
        description="Start, stop, or inspect the Hermes status monitor for Atoll.",
    )


__all__ = ["register"]
