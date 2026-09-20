// The systemd user service. Runs as the person, restarts on failure, and
// takes its jobs with it when stopped (KillMode=control-group, the default).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const systemctl = (...argv) => spawnSync('systemctl', ['--user', ...argv], { encoding: 'utf8' });

export function installUnit({ node, runner, here, user }) {
  const out = [];
  if (systemctl('show-environment').status !== 0) {
    if (existsSync('/proc/version') && /microsoft/i.test(readFileSync('/proc/version', 'utf8'))) {
      out.push('systemd is not running in this WSL distro. Enable it in /etc/wsl.conf ([boot] systemd=true),');
      out.push('run `wsl --shutdown` from PowerShell, reopen the distro and install again.');
    } else {
      out.push('systemd user session not available; run the runner by hand:');
    }
    out.push(`  ${node} ${runner}`);
    return out;
  }
  const unitDir = path.join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(path.join(unitDir, 'runlet.service'),
    readFileSync(path.join(here, 'runlet.service'), 'utf8')
      .replace(/__LITE_DIR__/g, here)
      .replace(/__NODE_BIN__\/node/g, node)
      .replace(/__NODE_BIN__/g, path.dirname(node)));
  systemctl('daemon-reload');
  systemctl('enable', 'runlet');
  // restart, not `enable --now`: --now only STARTS a stopped unit, so a
  // re-run that changed ExecStart would leave the old runner going and two
  // of them competing for the same queue.
  systemctl('restart', 'runlet');
  try { execFileSync('sudo', ['loginctl', 'enable-linger', user], { stdio: 'ignore' }); } catch { /* optional */ }
  out.push(`runlet.service: ${systemctl('is-active', 'runlet').stdout.trim()}`);
  out.push('Runner log: journalctl --user -u runlet -f');
  return out;
}
