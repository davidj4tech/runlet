#!/usr/bin/env python3
"""No cloud access: mock provisioning and check how install.sh routes it."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


def write_executable(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


class BootstrapTests(unittest.TestCase):
    """install.sh now only finds Node and hands over to install.mjs."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="runlet-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home with spaces & chars"
        self.repo = self.base / "checkout with spaces & chars"
        self.bin = self.base / "bin"
        for d in (self.home, self.repo, self.bin):
            d.mkdir()
        shutil.copy(ROOT / "install.sh", self.repo / "install.sh")
        (self.repo / "install.sh").chmod(0o755)
        self.log = self.base / "calls"
        self.env = dict(os.environ, HOME=str(self.home),
                        PATH=str(self.bin) + ":/usr/bin:/bin",
                        RUNLET_TEST_LOG=str(self.log), RUNLET_TEST_OS="Linux")
        for key in ("RUNLET", "RUNLET_CONF"):
            self.env.pop(key, None)
        self.stub("uname", 'echo "${RUNLET_TEST_OS}"')
        # Drop sudo's own options only; shifting unconditionally turned
        # `sudo apt-get install ...` into /usr/bin/install.
        self.stub("sudo", 'echo "sudo $*" >> "$RUNLET_TEST_LOG"; '
                          'while [[ "$1" == -* ]]; do shift; done; "$@"')
        self.stub("apt-get", 'echo "apt-get $*" >> "$RUNLET_TEST_LOG"')
        self.stub("curl", 'echo "curl $*" >> "$RUNLET_TEST_LOG"')
        self.stub("brew", 'echo "brew $*" >> "$RUNLET_TEST_LOG"; if [[ "$1" == --prefix ]]; then echo /brew; fi')

    def stub(self, name, body):
        write_executable(self.bin / name, "#!/bin/bash\n" + body + "\n")

    def with_node(self, version="v22.16.0"):
        self.stub("node", 'if [[ "$1" == -v ]]; then echo "' + version + '"; '
                          'else echo "node $*" >> "$RUNLET_TEST_LOG"; fi')

    def run_install(self, *args):
        return subprocess.run(["/bin/bash", str(self.repo / "install.sh"), *args],
                              env=self.env, text=True, capture_output=True)

    def calls(self):
        return self.log.read_text() if self.log.exists() else ""

    def test_hands_over_to_install_mjs_with_arguments(self):
        self.with_node()
        result = self.run_install("--no-service")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("node %s/install.mjs --no-service" % self.repo, self.calls())

    def test_installs_node_when_missing(self):
        # No node stub at all: the bootstrap must fetch one before handing over.
        result = self.run_install()
        self.assertIn("apt-get", self.calls())
        self.assertIn("nodesource", self.calls().lower())
        # It still fails, because the stubbed apt-get installs nothing.
        self.assertIn("not on PATH", result.stderr + result.stdout)

    def test_old_node_is_replaced(self):
        self.with_node("v18.19.0")
        self.run_install()
        self.assertIn("apt-get", self.calls())

    def test_macos_without_homebrew_says_so(self):
        self.env["RUNLET_TEST_OS"] = "Darwin"
        (self.bin / "brew").unlink()
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Homebrew", result.stderr)

    def test_unsupported_os_is_refused(self):
        self.env["RUNLET_TEST_OS"] = "SunOS"
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported operating system", result.stderr)


class InstallerLogicTests(unittest.TestCase):
    """The installer's own decisions -- see tests/check-install.mjs."""

    def test_install_logic(self):
        node = shutil.which("node")
        if node is None:
            alias = Path(os.environ.get("FNM_DIR", Path.home() / ".local/share/fnm"))
            candidate = alias / "aliases/default/bin/node"
            node = str(candidate) if candidate.is_file() else None
        if node is None:
            self.skipTest("Node is required for the installer tests")
        result = subprocess.run([node, str(ROOT / "tests/check-install.mjs")],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class WorkerTests(unittest.TestCase):
    """The Worker's runner API against real SQLite -- see tests/check-worker.mjs."""

    def test_runner_api(self):
        node = shutil.which("node")
        if node is None:
            alias = Path(os.environ.get("FNM_DIR", Path.home() / ".local/share/fnm"))
            candidate = alias / "aliases/default/bin/node"
            node = str(candidate) if candidate.is_file() else None
        if node is None:
            self.skipTest("Node 22.6+ is required for the Worker tests")
        result = subprocess.run(
            [node, "--experimental-strip-types", "--experimental-sqlite", "--no-warnings",
             str(ROOT / "tests/check-worker.mjs")],
            text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class RunnerTests(unittest.TestCase):
    """runlet.mjs against the real Worker -- see tests/check-runner.mjs."""

    def test_runner(self):
        node = shutil.which("node")
        if node is None:
            # Non-interactive shells on fnm-managed hosts may not have the
            # default alias on PATH; look where check-signing.sh looks.
            alias = Path(os.environ.get("FNM_DIR", Path.home() / ".local/share/fnm"))
            candidate = alias / "aliases/default/bin/node"
            node = str(candidate) if candidate.is_file() else None
        if node is None:
            self.skipTest("Node is required for the runner tests")
        result = subprocess.run(
            [node, "--experimental-strip-types", "--experimental-sqlite", "--no-warnings",
             str(ROOT / "tests/check-runner.mjs")],
            text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
