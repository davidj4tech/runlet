# Native Windows support — plan (20 Sep 2026)

## Where we are
- macOS support merged into main (fast-forward, commits 0eb4dad + 8aa3a51).
- lib/platform.sh is the seam: three hooks only —
  runlet_platform_init (PATH), runlet_start_session (setsid vs macos-job.py),
  runlet_load_average (/proc/loadavg vs sysctl).
- install.ps1 (41 lines) currently does nothing but bootstrap WSL2 + Ubuntu and
  hand off to install.sh. Going native means porting install.sh, not the PowerShell.

## Proposed shape
- Keep bash for Linux and macOS. Write a Node equivalent of the runner for Windows,
  sharing the same worker and wire protocol. Node is already a dependency (worker).
- Windows needs a fourth platform implementation plus Task Scheduler in place of
  systemd user services / launchd LaunchAgents.
- Ship a single signed executable rather than a hard WSL2 dependency.

## Notes
- Skills are SKILL.md markdown, not scripts — nothing to port there.
- Only genuine Linux dependency in the skill layer is tmux (claude-sessions,
  resume-tmux, music-transit). A process manager can stand in for it.
- mopidy / systemctl / snapcast / adb / speech all live on red5 and are reached
  over the network — they do not constrain the client platform.

## Related: agent-media
- 280 first-party .py files (218 in packages/core).
- Windows blockers: fcntl (~35) and posix (~86). mpv itself is cross-platform.
- termux / /storage/emulated / adb refs are Android-only by design.
- macOS nearly free; Windows is where the cost sits. Stage macOS first.
