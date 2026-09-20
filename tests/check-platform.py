#!/usr/bin/env python3
"""No cloud access: mock provisioning and check how install.sh routes it."""

import os
from pathlib import Path
import plistlib
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


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="runlet-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home with spaces & chars"
        self.repo = self.base / "checkout with spaces & chars"
        self.bin = self.base / "bin"
        self.prefix = self.base / "brew prefix"
        self.home.mkdir()
        self.repo.mkdir()
        self.bin.mkdir()
        for name in ("install.sh", "schema.sql", "worker/wrangler.jsonc.template"):
            dest = self.repo / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / name, dest)
        # Exercise the word-secret path too, without copying the real wordlist.
        (self.repo / "words.txt").write_text("\n".join(f"word{i}" for i in range(1300)) + "\n")
        (self.repo / "runlet.mjs").write_text("console.log('runlet-ok')\n")
        self.log = self.base / "calls"
        self.env = dict(os.environ, HOME=str(self.home), PATH=str(self.bin) + ":" + os.environ["PATH"],
                        RUNLET_TEST_LOG=str(self.log), RUNLET_TEST_PREFIX=str(self.prefix),
                        CLOUDFLARE_API_TOKEN="test-token", RUNLET_SITE="test", SSH_CONNECTION="test",
                        RUNLET_TEST_OS="Darwin", USER="runlet-test")
        for key in ("RUNLET", "RUNLET_CONF", "RUNLET_WORKER_NAME", "RUNLET_DB_NAME"):
            self.env.pop(key, None)
        self.stub("uname", 'echo "${RUNLET_TEST_OS}"')
        self.stub("brew", 'if [[ "$1" == --prefix ]]; then echo "$RUNLET_TEST_PREFIX"; else echo "brew $*" >> "$RUNLET_TEST_LOG"; fi')
        self.stub("node", 'echo v22.16.0')
        self.stub("npm", 'echo "npm $*" >> "$RUNLET_TEST_LOG"; echo 10.0.0')
        self.stub("launchctl", '''echo "launchctl $*" >> "$RUNLET_TEST_LOG"
if [[ "$1" == print && "${RUNLET_TEST_HEADLESS:-}" == 1 ]]; then exit 1; fi''')
        self.stub("plutil", 'echo "plutil $*" >> "$RUNLET_TEST_LOG"')
        self.stub("systemctl", 'echo "systemctl $*" >> "$RUNLET_TEST_LOG"; [[ "$1" == --user ]]')
        self.stub("setsid", 'echo "unexpected setsid invocation" >&2; exit 1')
        self.stub("sudo", 'echo "sudo $*" >> "$RUNLET_TEST_LOG"')
        self.stub("sleep", ':')
        self.stub("pbcopy", 'cat >/dev/null')
        self.stub("curl", '''echo "curl" >> "$RUNLET_TEST_LOG"
case "$*" in
  *user/tokens/verify*) echo '{"success":true,"result":{"status":"active"}}' ;;
  *per_page=50*) echo '{"result":[{"id":"account","name":"test"}]}' ;;
  *database?*) echo '{"result":[{"name":"runlet-test","uuid":"11111111-1111-1111-1111-111111111111"}]}' ;;
  *workers/subdomain*) echo '{"result":{"subdomain":"test"}}' ;;
  *run_command*) echo '{"result":{"content":[{"text":"#1 pending"}]}}' ;;
  *get_result*) echo '{"result":{"content":[{"text":"#1 done exit=0\\nrunlet-ok"}]}}' ;;
  *) echo "unexpected curl request" >&2; exit 1 ;;
esac''')
        write_executable(self.repo / "worker/node_modules/.bin/wrangler", '''#!/bin/bash
case "$*" in
  *PRAGMA*) echo '[{"results":[{"name":"background"},{"name":"cancel"},{"name":"runner"}]}]' ;;
  *secret*) cat >/dev/null ;;
  *) echo mock-wrangler ;;
esac
''')

    def stub(self, name, script):
        write_executable(self.bin / name, "#!/bin/bash\nset -eu\n" + script + "\n")

    def install(self, *args):
        result = subprocess.run(["/bin/bash", str(self.repo / "install.sh"), *args],
                                env=self.env, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_macos_install_and_repeat(self):
        self.install()
        config = (self.home / ".config/runlet/env").read_text()
        key = (self.home / ".config/runlet/relay.key").read_text()
        plist = self.home / "Library/LaunchAgents/org.runlet.runner.plist"
        with plist.open("rb") as stream:
            agent = plistlib.load(stream)
        # The runner is node now, not bash; the LaunchAgent must say so.
        self.assertEqual(agent["ProgramArguments"][1], str((self.repo / "runlet.mjs").resolve()))
        self.assertTrue(agent["ProgramArguments"][0].endswith("node"), agent["ProgramArguments"][0])
        self.assertEqual(agent["EnvironmentVariables"]["HOME"], str(self.home))
        if sys.platform == "darwin":
            subprocess.run(["/usr/bin/plutil", "-lint", str(plist)], check=True, capture_output=True)
        self.assertTrue(agent["KeepAlive"])
        self.assertIn(str(self.prefix), agent["EnvironmentVariables"]["PATH"])
        self.assertEqual(agent["StandardErrorPath"], str(self.home / "Library/Logs/runlet/runner.log"))
        # Sourcing the generated config must preserve spaces and metacharacters.
        command = '. "$HOME/.config/runlet/env"; printf "%s\\n%s" "$RUNLET_KEY_FILE" "$RUNLET_BREW_PREFIX"'
        values = subprocess.check_output(["/bin/bash", "-c", command], env=self.env, text=True)
        self.assertEqual(values, str(self.home / ".config/runlet/relay.key") + "\n" + str(self.prefix))
        self.install()
        self.assertEqual(config, (self.home / ".config/runlet/env").read_text())
        self.assertEqual(key, (self.home / ".config/runlet/relay.key").read_text())
        calls = self.log.read_text()
        self.assertIn("launchctl bootout", calls)
        self.assertIn("launchctl bootstrap", calls)
        self.assertNotIn("systemctl", calls)
        self.assertNotIn("sudo", calls)
        before = calls
        self.assertIn("https://runlet-test.test.workers.dev/", self.install("--print-url"))
        self.assertEqual(before, self.log.read_text())

    def test_no_service(self):
        self.install("--no-service")
        self.assertFalse((self.home / "Library/LaunchAgents").exists())
        self.assertNotIn("launchctl", self.log.read_text())

    def test_headless_install(self):
        self.env["RUNLET_TEST_HEADLESS"] = "1"
        self.assertIn("next desktop login", self.install())
        self.assertNotIn("launchctl bootstrap", self.log.read_text())

    def test_missing_node_uses_homebrew(self):
        self.stub("node", 'echo v18.0.0')
        self.install("--no-service")
        self.assertIn("brew install node@22", self.log.read_text())
        self.assertNotIn("sudo", self.log.read_text())

    def test_linux_keeps_systemd(self):
        self.env["RUNLET_TEST_OS"] = "Linux"
        # Linux's existing service renderer is tested with an ordinary path.
        self.repo.rename(self.base / "linux-checkout")
        self.repo = self.base / "linux-checkout"
        shutil.copy(ROOT / "runlet.service", self.repo / "runlet.service")
        self.install()
        self.assertTrue((self.home / ".config/systemd/user/runlet.service").exists())
        calls = self.log.read_text()
        # enable, then restart: --now only starts a STOPPED unit, so a re-run
        # that changed ExecStart would leave the old runner going.
        self.assertIn("systemctl --user enable runlet", calls)
        self.assertIn("systemctl --user restart runlet", calls)
        self.assertNotIn("launchctl", calls)
        self.assertNotIn("brew install", calls)


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
