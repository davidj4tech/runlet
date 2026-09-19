#!/usr/bin/env python3
"""No cloud access: mock provisioning, exercise real process supervision."""

import os
from pathlib import Path
import plistlib
import shutil
import signal
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
        write_executable(self.repo / "runlet.sh", "#!/bin/bash\necho runlet-ok\n")
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
        self.assertEqual(agent["ProgramArguments"], ["/bin/bash", str(self.repo / "runlet.sh")])
        self.assertEqual(agent["EnvironmentVariables"]["HOME"], str(self.home))
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
        self.assertIn("systemctl --user enable --now runlet", calls)
        self.assertNotIn("launchctl", calls)
        self.assertNotIn("brew install", calls)


class ProcessTests(unittest.TestCase):
    def start(self, script, *args):
        return subprocess.Popen([sys.executable, str(ROOT / "lib/macos-job.py"),
                                 "bash", "-c", script, "_", *map(str, args)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def test_output_and_exit_code(self):
        job = self.start('printf "hello\\n"; exit 7')
        out, err = job.communicate(timeout=5)
        self.assertEqual((job.returncode, out, err), (7, "hello\n", ""))

    def test_timeout(self):
        timeout = shutil.which("gtimeout") or shutil.which("timeout")
        self.assertIsNotNone(timeout, "GNU coreutils is required")
        job = self.start('exec "$1" --kill-after=1 0.2 bash -c "sleep 30"', timeout)
        job.communicate(timeout=5)
        self.assertEqual(job.returncode, 124)

    def exercise_cleanup(self, cancel):
        # A child that ignores TERM proves group cancellation/shutdown also
        # reaches descendants. Kill the test process group on assertion failure.
        job = self.start('echo $$; (trap "" TERM; echo child; exec sleep 30) & wait')
        pgid = int(job.stdout.readline())
        self.assertEqual(job.stdout.readline().strip(), "child")
        try:
            if cancel:
                os.killpg(pgid, signal.SIGKILL)
            else:
                job.terminate()
            job.communicate(timeout=5)
            self.assertEqual(job.returncode, 137 if cancel else 143)
            # A killed child may remain as a zombie briefly under container PID 1.
            ps = subprocess.check_output(["ps", "-axo", "pgid=,stat="], text=True)
            live = [line for line in ps.splitlines()
                    if line.split()[0] == str(pgid) and not line.split()[1].startswith("Z")]
            self.assertEqual(live, [])
        finally:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if job.poll() is None:
                job.kill()
                job.wait()

    def test_cancel_kills_descendants(self):
        self.exercise_cleanup(cancel=True)

    def test_service_shutdown_kills_descendants(self):
        self.exercise_cleanup(cancel=False)

    def test_symlinked_runner_help(self):
        with tempfile.TemporaryDirectory() as temp:
            link = Path(temp) / "runlet"
            link.symlink_to(ROOT / "runlet.sh")
            result = subprocess.run(["/bin/bash", str(link), "--help"], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("runlet skills", result.stdout)

    def test_empty_skills_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            env = dict(os.environ, RUNLET_CONF=temp, RUNLET_SKILLS_DIR=temp)
            env.pop("RUNLET", None)
            result = subprocess.run(["/bin/bash", str(ROOT / "runlet.sh"), "skills"],
                                    env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("No skills listed", result.stdout)

    def test_macos_load_average(self):
        with tempfile.TemporaryDirectory() as temp:
            write_executable(Path(temp) / "sysctl", '#!/bin/bash\necho "{ 1.25 2.50 3.75 }"\n')
            env = dict(os.environ, PATH=temp + ":" + os.environ["PATH"])
            script = '. "$1/lib/platform.sh"; RUNLET_OS=Darwin; runlet_load_average'
            result = subprocess.check_output(["/bin/bash", "-c", script, "_", str(ROOT)],
                                             env=env, text=True)
            self.assertEqual(result.strip(), "1.25")


if __name__ == "__main__":
    unittest.main(verbosity=2)
