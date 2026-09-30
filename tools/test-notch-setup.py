#!/usr/bin/env python3
"""Temp-directory tests for the Hermes Notch Plugin Atoll setup boundary."""

from __future__ import annotations

import contextlib
import io
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import notch_setup as setup  # noqa: E402


class NotchSetupTests(unittest.TestCase):
    def test_default_plan_selects_himanusia_fork_and_pinned_ref(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            plan = setup.build_setup_plan(
                home=home,
                hermes_home_path=home / ".hermes",
                app_paths=[],
                rpc_probe=lambda: False,
            )
            clone = plan.commands[0]
            self.assertEqual(plan.source_url, setup.ATOLL_REPO_URL)
            self.assertIn(setup.ATOLL_REPO_URL, clone)
            self.assertIn(setup.ATOLL_REF, clone)
            self.assertEqual(plan.candidate_path.name, "Atoll.app")
            self.assertIn("DynamicIsland.xcodeproj", " ".join(plan.commands[1]))
            self.assertNotIn("Ebullioscopic/Atoll", " ".join(clone))

    def test_upstream_or_other_remote_is_rejected(self):
        with self.assertRaises(setup.SetupError):
            setup.ensure_fork_remote("https://github.com/Ebullioscopic/Atoll.git")
        with self.assertRaises(setup.SetupError):
            setup.ensure_fork_remote("https://example.invalid/Atoll.git")

    def test_dry_run_does_not_clone_build_or_install(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            plan = setup.build_setup_plan(
                home=home,
                hermes_home_path=home / ".hermes",
                app_paths=[],
                rpc_probe=lambda: False,
            )
            calls = []

            def forbidden_runner(*args, **kwargs):
                calls.append((args, kwargs))
                raise AssertionError("dry-run invoked a command")

            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = setup.execute_setup(plan, dry_run=True, runner=forbidden_runner)
            self.assertEqual(result, 0)
            self.assertEqual(calls, [])
            self.assertIn(setup.ATOLL_REPO_URL, output.getvalue())
            self.assertFalse(plan.install_path.exists())

    def test_existing_app_is_detected_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            app = home / "Applications" / "Atoll.app"
            info = app / "Contents"
            info.mkdir(parents=True)
            with (info / "Info.plist").open("wb") as stream:
                plistlib.dump(
                    {
                        "CFBundleIdentifier": "com.Ebullioscopic.Atoll",
                        "CFBundleShortVersionString": "2.3.3",
                    },
                    stream,
                )
            marker = app / "keep-me.txt"
            marker.write_text("existing", encoding="utf-8")
            plan = setup.build_setup_plan(
                home=home,
                hermes_home_path=home / ".hermes",
                rpc_probe=lambda: True,
            )
            self.assertIsNotNone(plan.existing_app)
            assert plan.existing_app is not None
            self.assertEqual(plan.existing_app.bundle_id, "com.Ebullioscopic.Atoll")

            def forbidden_runner(*args, **kwargs):
                raise AssertionError("existing app caused a build")

            result = setup.execute_setup(
                plan,
                runner=forbidden_runner,
                system_name="Darwin",
            )
            self.assertEqual(result, 0)
            self.assertEqual(marker.read_text(encoding="utf-8"), "existing")

    def test_candidate_install_refuses_destructive_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate" / "Atoll.app"
            candidate.mkdir(parents=True)
            (candidate / "Contents").mkdir()
            target = root / "Applications" / "Atoll.app"
            target.mkdir(parents=True)
            marker = target / "keep-me.txt"
            marker.write_text("existing", encoding="utf-8")
            with self.assertRaises(setup.SetupError):
                setup.install_candidate(candidate, target)
            self.assertEqual(marker.read_text(encoding="utf-8"), "existing")

    def test_non_macos_build_reports_actionable_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = setup.build_setup_plan(
                home=root,
                hermes_home_path=root / ".hermes",
                app_paths=[],
                rpc_probe=lambda: False,
            )
            with self.assertRaisesRegex(setup.SetupError, "requires macOS"):
                setup.execute_setup(plan, system_name="Linux")

    def test_clone_failure_is_reported_without_installing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = setup.build_setup_plan(
                home=root,
                hermes_home_path=root / ".hermes",
                app_paths=[],
                rpc_probe=lambda: False,
            )

            def failing_runner(*args, **kwargs):
                return subprocess.CompletedProcess(args[0], 1, "", "network unavailable")

            with self.assertRaisesRegex(setup.SetupError, "fork clone failed"):
                setup.execute_setup(
                    plan,
                    runner=failing_runner,
                    command_exists=lambda _name: "/usr/bin/tool",
                    system_name="Darwin",
                )
            self.assertFalse(plan.install_path.exists())

    def test_rpc_probe_rejects_non_loopback_destination(self):
        with self.assertRaises(ValueError):
            setup.probe_loopback_rpc(host="192.0.2.10")


if __name__ == "__main__":
    unittest.main(verbosity=2)
