#!/usr/bin/env python3
"""Provide setsid plus launchd shutdown cleanup without a Linux utility."""

import os
import signal
import subprocess
import sys


def main():
    child = None
    stopping = None

    def stop(signum, _frame):
        nonlocal stopping
        stopping = signum
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, stop)

    # Popen creates a new session before exec, just like Linux setsid. The
    # shell writes its PID/PGID marker and then execs GNU timeout unchanged.
    child = subprocess.Popen(sys.argv[1:], start_new_session=True)
    if stopping is not None:
        stop(stopping, None)
    code = child.wait()
    if stopping is not None:
        return 128 + stopping
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(main())
