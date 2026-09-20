// The Scheduled Task: Windows' systemd user service. At logon, as the person
// rather than SYSTEM, no execution time limit, restart after a crash, one
// instance.
import { execFileSync } from 'node:child_process';

const ps = (script) => execFileSync('powershell.exe',
  ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', script], { encoding: 'utf8' });

// The action wraps node in powershell -WindowStyle Hidden: a console program
// started by the scheduler pops a window on the desktop at every logon, and
// the wrapper gives the log somewhere to go. .ToString(), not "$_": the
// command is already one double-quoted argument and Windows argument parsing
// eats a nested pair, silently undoing the stringify.
export const taskCommand = ({ node, runner, logPath }) =>
  `& '${node}' '${runner}' 2>&1 | ForEach-Object { $_.ToString() } | `
  + `Out-File -FilePath '${logPath}' -Append -Encoding utf8`;

export function registerTask({ node, runner, logPath, taskName = 'runlet' }) {
  const inner = taskCommand({ node, runner, logPath });
  const script = `
$ErrorActionPreference = 'Stop'
$argline = '-NoLogo -NonInteractive -NoProfile -WindowStyle Hidden -Command "${inner.replace(/'/g, "''")}"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argline -WorkingDirectory '${runner.replace(/\\[^\\]+$/, '')}'
# NOT "$env:USERDOMAIN\\$env:USERNAME": on a machine that is not domain-joined
# USERDOMAIN is WORKGROUP, which resolves to no account.
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries \`
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) \`
  -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger \`
  -Settings $settings -Principal $principal -Force | Out-Null
# Restart rather than start: a running instance keeps executing the command it
# was registered with, so a re-run that changed it would leave the old runner
# going. Stop first, because MultipleInstances IgnoreNew refuses a second start.
if ((Get-ScheduledTask -TaskName '${taskName}').State -eq 'Running') {
  Stop-ScheduledTask -TaskName '${taskName}'
  foreach ($i in 1..20) {
    if ((Get-ScheduledTask -TaskName '${taskName}').State -ne 'Running') { break }
    Start-Sleep -Milliseconds 250
  }
}
Start-ScheduledTask -TaskName '${taskName}'
Write-Output ((Get-ScheduledTask -TaskName '${taskName}').State)
`;
  const state = ps(script).trim().split(/\r?\n/).pop();
  return `task '${taskName}': ${state}; starts at logon\n    log: ${logPath}`;
}
