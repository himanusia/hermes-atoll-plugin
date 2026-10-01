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
    def test_default_plan_selects_himanusia_fork_and_immutable_ref(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            plan = setup.build_setup_plan(
                home=home,
                hermes_home_path=home / ".hermes",
                app_paths=[],
                rpc_probe=lambda: False,
            )
            clone, fetch, checkout, build = plan.commands
            self.assertRegex(setup.ATOLL_REF, r"^[0-9a-f]{40}$", "installer must pin an immutable commit, not a moving branch")
            self.assertEqual(plan.source_url, setup.ATOLL_REPO_URL)
            self.assertIn(setup.ATOLL_REPO_URL, clone)
            self.assertIn("--no-checkout", clone)
            self.assertEqual(fetch[-2:], ("origin", setup.ATOLL_REF))
            self.assertEqual(checkout[-2:], ("--detach", setup.ATOLL_REF))
            self.assertEqual(build[0], "xcodebuild")
            self.assertEqual(build[build.index("-project") + 1], str(plan.source_dir / "DynamicIsland.xcodeproj"))
            self.assertEqual(build[build.index("-derivedDataPath") + 1], str(plan.derived_data_dir))
            self.assertEqual(plan.candidate_path.name, "Atoll.app")
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

    def test_untrusted_local_identity_is_accepted_for_signing(self):
        seen = []

        def runner(command, **kwargs):
            seen.append(tuple(str(part) for part in command))
            stdout = (
                "Policy: Code Signing\n  Matching identities\n"
                f"  1) 46A744DDC047FF480787337F32BC505BADAC196D \"{setup.SIGNING_IDENTITY}\""
                " (CSSMERR_TP_NOT_TRUSTED)\n     1 identities found\n\n"
                "  Valid identities only\n     0 valid identities found\n"
            )
            return subprocess.CompletedProcess(command, 0, stdout, "")

        identities = setup.list_codesigning_identities(runner=runner)
        self.assertEqual(identities, (setup.SIGNING_IDENTITY,))
        self.assertEqual(seen, [("security", "find-identity", "-p", "codesigning")])
        self.assertEqual(setup.resolve_signing_identity(identities=identities), setup.SIGNING_IDENTITY)
        sign, verify = setup.signing_commands(Path("/tmp/Atoll.app"), setup.SIGNING_IDENTITY)
        self.assertIn("--deep", sign)
        self.assertEqual(sign[sign.index("--sign") + 1], setup.SIGNING_IDENTITY)
        self.assertEqual(verify, ("codesign", "--verify", "--deep", "--strict", "/tmp/Atoll.app"))

    def test_explicit_identity_must_exist_and_ad_hoc_is_the_fallback(self):
        with self.assertRaisesRegex(setup.SetupError, "not in this login keychain"):
            setup.resolve_signing_identity("Nonexistent Identity", identities=())
        self.assertIsNone(setup.resolve_signing_identity(identities=()))
        sign, _ = setup.signing_commands(Path("/tmp/Atoll.app"), None)
        self.assertEqual(sign[sign.index("--sign") + 1], "-")

    def test_signature_verification_failure_aborts_before_installing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "DerivedData" / "Build" / "Products" / "Release" / "Atoll.app"
            candidate.mkdir(parents=True)
            plan = setup.build_setup_plan(
                home=root,
                hermes_home_path=root / ".hermes",
                app_paths=[],
                rpc_probe=lambda: False,
                identities=(),
            )
            self.assertIsNone(plan.signing_identity)
            calls = []

            def runner(command, **kwargs):
                calls.append(tuple(str(part) for part in command))
                verifying = any("--verify" in str(part) for part in command)
                return subprocess.CompletedProcess(command, 1 if verifying else 0, "", "invalid signature")

            with self.assertRaisesRegex(setup.SetupError, "signature verification failed"):
                setup.sign_candidate(candidate, None, runner=runner)
            self.assertEqual(len(calls), 2)
            self.assertIn("--force", calls[0])
            self.assertFalse(plan.install_path.exists())

    def test_setup_builds_signs_verifies_then_installs_without_privileged_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "cache" / "hermes-notch-plugin" / "Atoll-src"
            (source / ".git").mkdir(parents=True)
            plan = setup.build_setup_plan(
                home=root,
                hermes_home_path=root / ".hermes",
                app_paths=[],
                rpc_probe=lambda: False,
                source_dir=source,
                derived_data_dir=root / "DerivedData",
                install_path=root / "Applications" / "Atoll.app",
                identities=(setup.SIGNING_IDENTITY,),
            )
            self.assertEqual(plan.signing_identity, setup.SIGNING_IDENTITY)
            (plan.candidate_path / "Contents").mkdir(parents=True)
            calls = []

            def runner(command, **kwargs):
                calls.append(tuple(str(part) for part in command))
                if "remote" in command:
                    return subprocess.CompletedProcess(command, 0, setup.ATOLL_REPO_URL + "\n", "")
                if "rev-parse" in command:
                    return subprocess.CompletedProcess(command, 0, setup.ATOLL_REF + "\n", "")
                return subprocess.CompletedProcess(command, 0, "", "")

            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = setup.execute_setup(
                    plan,
                    runner=runner,
                    command_exists=lambda name: f"/usr/bin/{name}",
                    system_name="Darwin",
                )

            self.assertEqual(result, 0)
            self.assertTrue((plan.install_path / "Contents").is_dir())
            emitted = " ".join(" ".join(command) for command in calls)
            for forbidden in ("sudo", "xattr", "tccutil", "add-trusted-cert", "csrutil"):
                self.assertNotIn(forbidden, emitted)
            self.assertIn("codesign --force --deep --sign", emitted)
            self.assertIn("codesign --verify --deep --strict", emitted)
            self.assertIn("xcodebuild", emitted)
            self.assertIn(setup.SIGNING_IDENTITY, output.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
