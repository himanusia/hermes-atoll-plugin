#!/usr/bin/env python3
"""Smoke-test the Hermes plugin contract without launching Atoll or a monitor."""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("hermes_atoll_plugin", ROOT / "__init__.py")
assert SPEC and SPEC.loader
PLUGIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLUGIN)


class RecordingContext:
    def __init__(self) -> None:
        self.hooks = []
        self.commands = []

    def register_hook(self, name, callback):
        self.hooks.append((name, callback))

    def register_cli_command(self, **kwargs):
        self.commands.append(kwargs)


def main() -> None:
    context = RecordingContext()
    PLUGIN.register(context)
    assert [name for name, _callback in context.hooks] == ["on_session_start"]
    assert [command["name"] for command in context.commands] == ["notch", "atoll"]

    parser = argparse.ArgumentParser()
    context.commands[0]["setup_fn"](parser)
    assert parser.parse_args(["setup", "--dry-run"]).atoll_action == "setup"
    assert parser.parse_args(["status"]).atoll_action == "status"
    assert parser.parse_args(["stop"]).atoll_action == "stop"
    assert parser.parse_args(["restart"]).atoll_action == "restart"
    print("Hermes plugin registration and CLI smoke test passed.")


if __name__ == "__main__":
    main()
