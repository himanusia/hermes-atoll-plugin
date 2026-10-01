"""Safe Atoll setup for the Hermes Notch Plugin.

The setup path is deliberately source-only until the fork publishes a verified
release asset. It always clones the maintained himanusia/Atoll fork at an
explicit ref, builds the native DynamicIsland scheme unsigned, and installs
only into a new user-owned Applications path. An existing Atoll.app is never
replaced automatically.
"""

from __future__ import annotations

import os
import plistlib
import platform
import re
import shutil
import socket
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

PRODUCT_NAME = "Hermes Notch Plugin"
ATOLL_REPO_URL = "https://github.com/himanusia/Atoll.git"
ATOLL_REPO_CANONICAL = "github.com/himanusia/atoll"
# Immutable fork commit carrying the extension peek/open-panel work.
ATOLL_REF = "3ad728b8c318a51a6098949241d2ca4b6b99e637"
ATOLL_PROJECT = "DynamicIsland.xcodeproj"
ATOLL_SCHEME = "DynamicIsland"
ATOLL_APP_NAME = "Atoll.app"
ATOLL_RPC_HOST = "127.0.0.1"
ATOLL_RPC_PORT = 9020


class SetupError(RuntimeError):
    """A setup failure that can be shown directly by the plugin CLI."""


@dataclass(frozen=True)
class InstalledAtoll:
    """A discovered Atoll bundle; metadata is best-effort and never trusted for replacement."""

    path: Path
    bundle_id: Optional[str] = None
    version: Optional[str] = None
    display_name: Optional[str] = None


@dataclass(frozen=True)
class RuntimeStatus:
    app: Optional[InstalledAtoll]
    rpc_reachable: bool


@dataclass(frozen=True)
class SetupPlan:
    """A side-effect-free description of the source-build route."""

    ref: str
    source_url: str
    source_dir: Path
    derived_data_dir: Path
    install_path: Path
    candidate_path: Path
    existing_app: Optional[InstalledAtoll]
    rpc_reachable: bool
    commands: Tuple[Tuple[str, ...], ...]

    @property
    def can_install(self) -> bool:
        return self.existing_app is None


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes")).expanduser()


def _normalise_ref(ref: str) -> str:
    value = str(ref or "").strip()
    if not value or value.startswith("-") or any(ord(ch) < 32 for ch in value):
        raise SetupError("Atoll source ref must be a non-empty branch, tag, or commit SHA.")
    return value


def _slug(ref: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in ref).strip("-") or "source"


def _is_commit_sha(ref: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{40}", ref))


def _default_app_paths(home: Optional[Path] = None) -> Tuple[Path, ...]:
    user_home = (home or Path.home()).expanduser()
    paths = [user_home / "Applications" / ATOLL_APP_NAME]
    system_path = Path("/Applications") / ATOLL_APP_NAME
    if system_path not in paths:
        paths.append(system_path)
    return tuple(paths)


def _read_bundle_metadata(app_path: Path) -> Dict[str, str]:
    plist_path = app_path / "Contents" / "Info.plist"
    try:
        with plist_path.open("rb") as stream:
            raw = plistlib.load(stream)
    except (OSError, ValueError, plistlib.InvalidFileException):
        return {}
    if not isinstance(raw, dict):
        return {}
    result = {}
    for key in ("CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleDisplayName", "CFBundleName"):
        value = raw.get(key)
        if value is not None:
            result[key] = str(value)
    return result


def discover_atoll_app(app_paths: Optional[Iterable[Path]] = None, home: Optional[Path] = None) -> Optional[InstalledAtoll]:
    """Find an existing Atoll bundle without modifying it.

    A directory with an unreadable or malformed Info.plist still counts as an
    existing app. This is intentional: unknown bundles must never be replaced
    merely because their provenance cannot be read.
    """

    for raw_path in app_paths if app_paths is not None else _default_app_paths(home):
        path = Path(raw_path).expanduser()
        if not path.is_dir():
            continue
        metadata = _read_bundle_metadata(path)
        return InstalledAtoll(
            path=path,
            bundle_id=metadata.get("CFBundleIdentifier"),
            version=metadata.get("CFBundleShortVersionString"),
            display_name=metadata.get("CFBundleDisplayName") or metadata.get("CFBundleName"),
        )
    return None


def probe_loopback_rpc(
    host: str = ATOLL_RPC_HOST,
    port: int = ATOLL_RPC_PORT,
    timeout: float = 0.25,
    connector: Callable = socket.create_connection,
) -> bool:
    """Check the Atoll RPC TCP listener, refusing non-loopback destinations."""

    if host not in {"127.0.0.1", "::1"}:
        raise ValueError("Atoll RPC probes must stay on loopback (127.0.0.1 or ::1).")
    try:
        connection = connector((host, int(port)), timeout=timeout)
    except OSError:
        return False
    try:
        connection.close()
    except OSError:
        pass
    return True


def inspect_runtime(
    app_paths: Optional[Iterable[Path]] = None,
    home: Optional[Path] = None,
    rpc_probe: Callable[[], bool] = probe_loopback_rpc,
) -> RuntimeStatus:
    return RuntimeStatus(
        app=discover_atoll_app(app_paths=app_paths, home=home),
        rpc_reachable=bool(rpc_probe()),
    )


def _canonical_repo(url: str) -> str:
    value = str(url or "").strip().rstrip("/").removesuffix(".git").lower()
    if value.startswith("https://"):
        value = value[len("https://") :]
    elif value.startswith("http://"):
        value = value[len("http://") :]
    elif value.startswith("git@"):
        value = value[len("git@") :].replace(":", "/", 1)
    elif value.startswith("ssh://git@"):
        value = value[len("ssh://git@") :]
    return value


def ensure_fork_remote(remote_url: str) -> None:
    """Reject an upstream or otherwise unrelated Atoll source tree."""

    if _canonical_repo(remote_url) != ATOLL_REPO_CANONICAL:
        raise SetupError(
            "Refusing Atoll source: expected the himanusia/Atoll fork "
            f"({ATOLL_REPO_URL}), got {remote_url!r}."
        )


def _command(*parts: object) -> Tuple[str, ...]:
    return tuple(str(part) for part in parts)


def source_build_commands(
    source_dir: Path,
    derived_data_dir: Path,
    ref: str = ATOLL_REF,
) -> Tuple[Tuple[str, ...], ...]:
    """Return the exact non-shell commands used by a source build."""

    ref = _normalise_ref(ref)
    source_dir = Path(source_dir).expanduser()
    derived_data_dir = Path(derived_data_dir).expanduser()
    if _is_commit_sha(ref):
        clone = _command(
            "git", "clone", "--filter=blob:none", "--no-checkout", ATOLL_REPO_URL, source_dir
        )
        checkout = (
            _command("git", "-C", source_dir, "fetch", "--depth", "1", "origin", ref),
            _command("git", "-C", source_dir, "checkout", "--detach", ref),
        )
    else:
        clone = _command(
            "git",
            "clone",
            "--depth",
            "1",
            "--filter=blob:none",
            "--branch",
            ref,
            "--single-branch",
            ATOLL_REPO_URL,
            source_dir,
        )
        checkout = ()
    build = _command(
        "xcodebuild",
        "-project",
        source_dir / ATOLL_PROJECT,
        "-scheme",
        ATOLL_SCHEME,
        "-configuration",
        "Release",
        "-derivedDataPath",
        derived_data_dir,
        "CODE_SIGNING_ALLOWED=NO",
        "CODE_SIGNING_REQUIRED=NO",
        "CODE_SIGN_IDENTITY=",
    )
    return (clone, *checkout, build)


def build_setup_plan(
    *,
    home: Optional[Path] = None,
    hermes_home_path: Optional[Path] = None,
    app_paths: Optional[Iterable[Path]] = None,
    ref: str = ATOLL_REF,
    source_dir: Optional[Path] = None,
    derived_data_dir: Optional[Path] = None,
    install_path: Optional[Path] = None,
    rpc_probe: Callable[[], bool] = probe_loopback_rpc,
) -> SetupPlan:
    """Create a source-build plan without cloning, building, or installing."""

    ref = _normalise_ref(ref)
    user_home = (home or Path.home()).expanduser()
    h_home = (hermes_home_path or (user_home / ".hermes")).expanduser()
    root = h_home / "cache" / "hermes-notch-plugin"
    source = Path(source_dir).expanduser() if source_dir else root / ("Atoll-" + _slug(ref))
    derived = Path(derived_data_dir).expanduser() if derived_data_dir else root / ("DerivedData-" + _slug(ref))
    install = Path(install_path).expanduser() if install_path else user_home / "Applications" / ATOLL_APP_NAME
    existing = discover_atoll_app(app_paths=app_paths, home=user_home)
    rpc = bool(rpc_probe())
    commands = source_build_commands(source, derived, ref)
    candidate = derived / "Build" / "Products" / "Release" / ATOLL_APP_NAME
    return SetupPlan(
        ref=ref,
        source_url=ATOLL_REPO_URL,
        source_dir=source,
        derived_data_dir=derived,
        install_path=install,
        candidate_path=candidate,
        existing_app=existing,
        rpc_reachable=rpc,
        commands=commands,
    )


def format_setup_plan(plan: SetupPlan) -> str:
    lines = [
        f"{PRODUCT_NAME} setup (dry run)",
        f"Atoll source: {plan.source_url}",
        f"Atoll ref: {plan.ref}",
        f"Build: unsigned source build via Xcode scheme {ATOLL_SCHEME}",
        f"Candidate: {plan.candidate_path}",
        f"Install target: {plan.install_path}",
    ]
    if plan.existing_app:
        lines.append(
            f"Existing Atoll.app: {plan.existing_app.path} "
            "(provenance not assumed; kept and never replaced)"
        )
    else:
        lines.append("Existing Atoll.app: not found")
    lines.append(f"Loopback RPC 127.0.0.1:{ATOLL_RPC_PORT}: {'reachable' if plan.rpc_reachable else 'not reachable'}")
    lines.append("No release asset is assumed; no permissions, xattrs, sudo, launch, or restart are performed.")
    if plan.existing_app is None:
        lines.extend("Command: " + " ".join(command) for command in plan.commands)
    else:
        lines.append("Action: keep the installed app; launch/configure Atoll separately if RPC is not reachable.")
    return "\n".join(lines)


def _run(command: Sequence[str], *, cwd: Optional[Path] = None, runner: Callable = subprocess.run):
    try:
        return runner(
            list(command),
            cwd=str(cwd) if cwd else None,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        raise SetupError(f"Could not run {' '.join(command)}: {exc}") from exc


def _require_command(name: str, command_exists: Callable[[str], Optional[str]]) -> None:
    if not command_exists(name):
        if name == "xcodebuild":
            raise SetupError("Xcode (xcodebuild) is required for the Atoll fork source build.")
        raise SetupError(f"{name} is required for the Atoll fork source build.")


def _check_result(result, command: Sequence[str], label: str) -> None:
    if getattr(result, "returncode", 1) == 0:
        return
    detail = (getattr(result, "stderr", "") or getattr(result, "stdout", "") or "").strip()
    suffix = f": {detail[-800:]}" if detail else ""
    raise SetupError(f"Atoll {label} failed{suffix}")


def _verify_source_tree(source_dir: Path, *, runner: Callable = subprocess.run) -> None:
    if not source_dir.is_dir() or not (source_dir / ".git").exists():
        raise SetupError(f"Atoll source directory is not a Git checkout: {source_dir}")
    result = _run(_command("git", "-C", source_dir, "remote", "get-url", "origin"), runner=runner)
    _check_result(result, result.args if hasattr(result, "args") else (), "fork verification")
    ensure_fork_remote((result.stdout or "").strip())


def _verify_source_ref(source_dir: Path, ref: str, *, runner: Callable = subprocess.run) -> None:
    """Require the checkout's HEAD to be exactly the requested ref."""

    expected = _run(
        _command("git", "-C", source_dir, "rev-parse", "--verify", f"{ref}^{{commit}}"),
        runner=runner,
    )
    _check_result(expected, (), "ref verification")
    actual = _run(_command("git", "-C", source_dir, "rev-parse", "HEAD"), runner=runner)
    _check_result(actual, (), "HEAD verification")
    expected_sha = (expected.stdout or "").strip()
    actual_sha = (actual.stdout or "").strip()
    if not expected_sha or expected_sha != actual_sha:
        raise SetupError(
            f"Atoll checkout is not pinned to requested ref {ref!r} "
            f"(HEAD {actual_sha or 'unknown'}, expected {expected_sha or 'unknown'})."
        )


def install_candidate(candidate_path: Path, install_path: Path) -> Path:
    """Copy a newly built app only when the destination does not exist."""

    candidate = Path(candidate_path).expanduser()
    target = Path(install_path).expanduser()
    if not candidate.is_dir():
        raise SetupError(f"Unsigned Atoll build did not produce {candidate}")
    if target.exists():
        raise SetupError(
            f"Refusing to replace existing app at {target}. "
            "Keep the existing Atoll installation and choose a new target explicitly."
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copytree(candidate, target)
    except FileExistsError as exc:
        raise SetupError(f"Refusing to replace an app that appeared at {target}") from exc
    return target


def execute_setup(
    plan: SetupPlan,
    *,
    dry_run: bool = False,
    runner: Callable = subprocess.run,
    command_exists: Callable[[str], Optional[str]] = shutil.which,
    system_name: Optional[str] = None,
) -> int:
    """Execute a plan, or print it when *dry_run* is true."""

    if dry_run:
        print(format_setup_plan(plan))
        return 0

    if plan.existing_app:
        print(
            f"{PRODUCT_NAME}: found existing Atoll.app at {plan.existing_app.path}; "
            "provenance is not assumed and it will not be replaced."
        )
        if plan.rpc_reachable:
            print(f"Atoll loopback RPC is reachable at {ATOLL_RPC_HOST}:{ATOLL_RPC_PORT}; setup is already complete.")
        else:
            print(
                "Atoll loopback RPC is not reachable. Launch Atoll and enable its local extension API; "
                "this command will not click permissions or restart it."
            )
        return 0

    if (system_name or platform.system()) != "Darwin":
        raise SetupError("The Atoll source build requires macOS.")
    _require_command("git", command_exists)
    _require_command("xcodebuild", command_exists)

    source_exists = plan.source_dir.exists()
    if source_exists:
        _verify_source_tree(plan.source_dir, runner=runner)
    else:
        clone = _run(plan.commands[0], runner=runner)
        _check_result(clone, plan.commands[0], "fork clone")
        for command in plan.commands[1:-1]:
            step = _run(command, runner=runner)
            _check_result(step, command, "exact ref checkout")
        _verify_source_tree(plan.source_dir, runner=runner)
    _verify_source_ref(plan.source_dir, plan.ref, runner=runner)

    build = _run(plan.commands[-1], cwd=plan.source_dir, runner=runner)
    _check_result(build, plan.commands[-1], "unsigned build")
    install_candidate(plan.candidate_path, plan.install_path)
    print(f"Installed unsigned {ATOLL_APP_NAME} from {plan.source_url} at ref {plan.ref} to {plan.install_path}.")
    print("Not notarized; no launch or restart was performed. Start Atoll yourself, then run `hermes notch status`.")
    return 0


def print_runtime_status() -> int:
    status = inspect_runtime()
    if status.app is None:
        print(f"{PRODUCT_NAME}: Atoll.app not found in ~/Applications or /Applications.")
    else:
        identity = status.app.bundle_id or "bundle identity unreadable"
        version = f", version {status.app.version}" if status.app.version else ""
        print(f"{PRODUCT_NAME}: Atoll.app at {status.app.path} ({identity}{version}); existing app kept.")
    rpc = "reachable" if status.rpc_reachable else "not reachable"
    print(f"Atoll loopback RPC 127.0.0.1:{ATOLL_RPC_PORT}: {rpc}.")
    return 0


def add_setup_arguments(parser) -> None:
    parser.add_argument("--dry-run", action="store_true", help="Plan the fork source build without changing the system")
    parser.add_argument("--atoll-ref", default=ATOLL_REF, help=f"Fork branch/tag/commit (default: {ATOLL_REF})")
    parser.add_argument("--source-dir", type=Path, help="Existing/new fork checkout directory")
    parser.add_argument("--derived-data-dir", type=Path, help="Xcode DerivedData directory")
    parser.add_argument("--install-path", type=Path, help="New user-owned Atoll.app destination")


__all__ = [
    "ATOLL_REF",
    "ATOLL_REPO_URL",
    "PRODUCT_NAME",
    "RuntimeStatus",
    "SetupError",
    "SetupPlan",
    "add_setup_arguments",
    "build_setup_plan",
    "discover_atoll_app",
    "ensure_fork_remote",
    "execute_setup",
    "format_setup_plan",
    "hermes_home",
    "inspect_runtime",
    "install_candidate",
    "print_runtime_status",
    "probe_loopback_rpc",
    "source_build_commands",
]
