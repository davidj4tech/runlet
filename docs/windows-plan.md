# Native Windows support (updated 20 Sep 2026)

> Superseded in part: `runlet.mjs` is now the runner on every platform, and
> `runlet.sh`, `lib/platform.sh` and `lib/macos-job.py` are gone. What follows
> is the Windows-specific record.

## Where we are
- Native Windows works and is tested on a real machine (HPO: Node 22.20.0,
  Windows PowerShell 5.1) as well as on `windows-latest` in CI.
- `runlet.mjs` is the runner, shared with Linux and macOS; only the process
  handling (taskkill, PowerShell, %LOCALAPPDATA%) differs on Windows.
- `install.ps1` is the installer: it provisions Cloudflare, writes
  `%APPDATA%\runlet\{env,relay.key}` and registers a Scheduled Task. The WSL2
  bootstrap it used to be is gone.
- `tests/check-runner.mjs` (23 cases, every platform) and
  `tests/check-windows-install.ps1` (10 cases, Windows only) cover both.

## What the port actually cost
Three bugs that only a real Windows run could find, all in plumbing that
looked obviously correct:

- `spawn` rejects a fresh `createWriteStream` (its `fd` is still `null`), so
  every job threw after being claimed and wedged its row in `running`.
- `detached: true` on win32 is not a process group. It sets
  `DETACHED_PROCESS`, denying the child a console; PowerShell 5.1 then exits 0
  having run nothing, so every job reported success with no output. Detach on
  POSIX only; `taskkill /T` walks the tree by pid and needs nothing.
- `$env:USERDOMAIN` is `WORKGROUP` on a machine that is not domain-joined, and
  `WORKGROUP\user` maps to no account, so `Register-ScheduledTask` failed
  outright. `[WindowsIdentity]::GetCurrent().Name` is the resolvable name.

`taskkill` also refuses to stop a console process without `/F` ("can only be
terminated forcefully"), so the graceful phase before a forced kill is skipped
on Windows rather than waited out -- it cost 10s on every timeout.

## Still open
- ~~No `--help` on Windows~~ — `runlet --help` is in the runner now.
- No log rotation for `%APPDATA%\runlet\runner.log`. The journal and launchd
  handle this for the other two platforms; Task Scheduler does not.
- A single signed executable, so Node is not a prerequisite, remains a
  packaging question rather than a code one.
- `install.ps1` has not been run end to end against a real Cloudflare account
  on Windows; its helpers are tested, its provisioning path is not.

## Related: agent-media
- 280 first-party .py files (218 in packages/core).
- Windows blockers: fcntl (~35) and posix (~86). mpv itself is cross-platform.
- termux / /storage/emulated / adb refs are Android-only by design.
- macOS nearly free; Windows is where the cost sits. Stage macOS first.
