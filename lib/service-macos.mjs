// The macOS LaunchAgent. A per-user login agent, not a system daemon: the
// runner executes the person's commands as them.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LABEL = 'com.sasonica.shell';

// A plist is XML, and these paths can hold spaces and & -- escape rather than
// interpolate. Only the five types this file uses.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const plist = ({ node, runner, home, logs }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(node)}</string><string>${esc(runner)}</string></array>
  <key>WorkingDirectory</key><string>${esc(home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${esc(home)}</string>
    <key>PATH</key><string>${esc(`${home}/.local/bin:${path.dirname(node)}:${process.env.PATH ?? ''}`)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(`${logs}/runner.log`)}</string>
  <key>StandardErrorPath</key><string>${esc(`${logs}/runner.log`)}</string>
</dict>
</plist>
`;

export function installAgent({ node, runner, home }) {
  const out = [];
  const file = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const logs = path.join(home, 'Library', 'Logs', 'sasonica');
  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(logs, { recursive: true });
  writeFileSync(file, plist({ node, runner, home, logs }));
  spawnSync('plutil', ['-lint', file], { stdio: 'ignore' });

  const domain = `gui/${process.getuid()}`;
  if (spawnSync('launchctl', ['print', domain], { stdio: 'ignore' }).status !== 0) {
    out.push('LaunchAgent installed; it will start at your next desktop login.');
    out.push(`To run now in this session: ${node} ${runner}`);
    return out;
  }
  // Re-running replaces a loaded definition, and re-enables a disabled one.
  if (spawnSync('launchctl', ['print', `${domain}/${LABEL}`], { stdio: 'ignore' }).status === 0) {
    spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
  }
  spawnSync('launchctl', ['enable', `${domain}/${LABEL}`], { stdio: 'ignore' });
  spawnSync('launchctl', ['bootstrap', domain, file], { stdio: 'ignore' });
  out.push(`${LABEL} installed; starts now and at login`);
  out.push(`Runner log: tail -f "${logs}/runner.log"`);
  return out;
}
