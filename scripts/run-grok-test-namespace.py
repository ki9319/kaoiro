#!/usr/bin/env python3
"""Isolate signal tests and reap adopted children inside their PID namespace."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys


def main(args: list[str]) -> int:
    if args and args[0] == "--init":
        child = subprocess.Popen(args[1:])
        # PID 1 must reap orphans: zombies keep kill(pgid, 0) successful.
        while True:
            pid, status = os.waitpid(-1, 0)
            if pid == child.pid:
                return os.waitstatus_to_exitcode(status)
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        print("usage: run-grok-test-namespace.py -- COMMAND", file=sys.stderr)
        return 2
    if any(shutil.which(name) is None for name in ("setsid", "unshare")):
        print("Grok tests require setsid and unshare", file=sys.stderr)
        return 2
    command = [
        "setsid", "-w", "unshare", "--user", "--map-root-user",
        "--pid", "--fork", "--mount-proc", sys.executable,
        os.path.abspath(__file__), "--init", *args,
    ]
    try:
        return subprocess.run(command, check=False).returncode
    except OSError as error:
        print(f"Grok namespace could not start: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    result = main(sys.argv[1:])
    raise SystemExit(result if result >= 0 else 128 - result)
