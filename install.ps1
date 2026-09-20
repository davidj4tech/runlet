<#
  install.ps1 -- runlet on Windows, natively: from a Cloudflare API token to a
  running runner. No WSL2.

      .\install.ps1                 # interactive: asks for the token if not in env
      .\install.ps1 -NoService      # everything except registering the runner
      .\install.ps1 -PrintUrl       # print this machine's connector URL and exit

  Run it from PowerShell in this folder:

      Set-ExecutionPolicy -Scope Process Bypass; .\install.ps1

  The ONE manual step is the token. Create it at
    https://dash.cloudflare.com/profile/api-tokens  ->  Create Token  ->  Custom
  with these permissions, all at Account scope:
    Workers Scripts : Edit
    D1              : Edit
    Account Settings: Read

  From that token this script does what install.sh does on Linux and macOS:
  finds the account, creates the D1 database, applies the schema, registers a
  workers.dev subdomain if the account has none, generates the HMAC key and the
  URL secret, sets both as Worker secrets, deploys the Worker, writes
  %APPDATA%\runlet\{env,relay.key}, and registers the runner as a Scheduled
  Task that starts at logon. Re-running is safe: every step checks first.

  The runner itself is win\runlet.mjs (Node), not runlet.sh.

  -Lib dot-sources the helpers without installing anything, for
  tests\check-windows-install.ps1.
#>
[CmdletBinding()]
param(
  [switch]$NoService,
  [switch]$PrintUrl,
  [switch]$Lib
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 still defaults to TLS 1.0 on some builds; the
# Cloudflare API refuses it.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:Api = 'https://api.cloudflare.com/client/v4'

function Write-Say  { param([string]$m) Write-Host "`n==> $m" -ForegroundColor White }
function Write-Note { param([string]$m) Write-Host "    $m" }
function Stop-Install { param([string]$m) throw $m }

# npm and wrangler each ship a .ps1 shim beside their .cmd, and PowerShell
# prefers the .ps1. npm's does `if ($MyInvocation.Statement)`, which
# Set-StrictMode -Version Latest turns into a hard error ("The property
# 'Statement' cannot be found on this object"), so a bare `npm` call fails
# before npm itself starts. Always go through the .cmd.
function Resolve-NodeTool {
  param([Parameter(Mandatory)][string]$Name)
  $cmd = Get-Command "$Name.cmd" -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $any = Get-Command $Name -ErrorAction SilentlyContinue
  if ($any) { return $any.Source }
  $null
}

# Merging a native command's stderr into the pipeline (2>&1) turns every
# stderr line into an ErrorRecord, and with $ErrorActionPreference = 'Stop'
# the first one is fatal. The runner logs to stderr by design, exactly as
# runlet.sh does, so capture its output with the preference relaxed and judge
# it by its exit code instead.
function Invoke-Native {
  param([Parameter(Mandatory)][string]$Exe, [string[]]$Arguments = @())
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  [pscustomobject]@{ ExitCode = $code; Output = @($out) }
}

function Get-RunletConf {
  if ($env:RUNLET_CONF) { return $env:RUNLET_CONF }
  Join-Path $env:APPDATA 'runlet'
}

# --- files -------------------------------------------------------------------
# Every file here is read by win\runlet.mjs, whose env parser anchors each line
# at ^\s*(KEY)=. Windows PowerShell's -Encoding UTF8 writes a BOM, which would
# hide the FIRST key behind three bytes it cannot match -- the token, as it
# happens. So: UTF-8 with no BOM, always.
function Write-TextNoBom {
  param([string]$Path, [string]$Text)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

function Read-EnvFile {
  param([string]$Path)
  $out = [ordered]@{}
  if (-not (Test-Path $Path)) { return $out }
  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    $m = [regex]::Match($line, '^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$')
    if ($m.Success) { $out[$m.Groups[1].Value] = $m.Groups[2].Value.Trim() }
  }
  $out
}

function Write-EnvFile {
  param([string]$Path, $Values)
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine("# runlet -- written by install.ps1 $(Get-Date -Format yyyy-MM-dd). The token here is")
  [void]$sb.AppendLine('# what the runner uses to read and write the queue; keep this file private.')
  foreach ($k in $Values.Keys) { [void]$sb.AppendLine("$k=$($Values[$k])") }
  Write-TextNoBom -Path $Path -Text $sb.ToString()
  Protect-File -Path $Path
}

# chmod 600, as Windows spells it: break inheritance, grant this user only.
function Protect-File {
  param([string]$Path)
  try {
    & icacls.exe $Path /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  } catch { Write-Note "could not restrict permissions on $Path" }
}

# --- names and secrets -------------------------------------------------------
# One account can hold several of these (one per machine). The site names this
# one; it goes into the Worker and database names so they never collide.
function ConvertTo-SiteName {
  param([string]$Raw)
  if (-not $Raw) { return 'site' }
  $s = $Raw.ToLowerInvariant()
  $s = [regex]::Replace($s, '[^a-z0-9-]', '-')
  $s = $s.Trim('-')
  if ($s.Length -gt 30) { $s = $s.Substring(0, 30).Trim('-') }
  if (-not $s) { return 'site' }
  $s
}

function Get-RandomBytes {
  param([int]$Count)
  $b = New-Object byte[] $Count
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  ,$b
}

function New-HexSecret {
  param([int]$Bytes = 32)
  ((Get-RandomBytes -Count $Bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
}

# Rejection sampling, not modulo: a plain % over 2^32 would quietly favour the
# first few words of the list, and this secret is a shell on the machine.
function Get-RandomIndex {
  param([int]$Bound)
  $limit = [uint32]([Math]::Floor([uint32]::MaxValue / $Bound) * $Bound)
  while ($true) {
    $v = [BitConverter]::ToUInt32((Get-RandomBytes -Count 4), 0)
    if ($v -lt $limit) { return [int]($v % $Bound) }
  }
}

# Random words from the EFF short list, as install.sh picks them: a URL a
# person can read back over the phone. Hex if the list is missing.
function New-UrlSecret {
  param([string]$WordsPath, [int]$Words = 5)
  if ($Words -lt 4) { Write-Note "RUNLET_SECRET_WORDS=$Words is too few; using 5"; $Words = 5 }
  if ((Test-Path $WordsPath)) {
    $list = @([System.IO.File]::ReadAllLines($WordsPath) | Where-Object { $_.Trim() })
    if ($list.Count -gt 1000) {
      return (1..$Words | ForEach-Object { $list[(Get-RandomIndex -Bound $list.Count)] }) -join '-'
    }
  }
  New-HexSecret -Bytes 24
}

function Get-ConnectorUrl {
  param($EnvValues)
  if (-not $EnvValues.Contains('RUNLET_WORKER_URL') -or -not $EnvValues.Contains('RUNLET_URL_SECRET')) { return $null }
  $u = $EnvValues['RUNLET_WORKER_URL']; $s = $EnvValues['RUNLET_URL_SECRET']
  if (-not $u -or -not $s) { return $null }
  "$u/$s/mcp"
}

# --- Cloudflare --------------------------------------------------------------
function Invoke-Cf {
  param([string]$Path, [string]$Method = 'GET', $Body = $null, [string]$Token)
  $req = @{
    Uri     = "$script:Api$Path"
    Method  = $Method
    Headers = @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' }
  }
  if ($null -ne $Body) { $req.Body = ($Body | ConvertTo-Json -Depth 5 -Compress) }
  Invoke-RestMethod @req
}

# --- the service -------------------------------------------------------------
# Task Scheduler is Windows' systemd user service / LaunchAgent: at logon, kept
# alive, and running as the person rather than SYSTEM -- the runner executes
# their commands as them, so it must not have more rights than they do.
#
# The action is powershell -WindowStyle Hidden wrapping node, not node itself:
# a console program started by the scheduler pops a console window on the
# desktop at every logon, and the wrapper also gives somewhere to put the log.
# NOT "$env:USERDOMAIN\$env:USERNAME": on a machine that is not joined to a
# domain USERDOMAIN is WORKGROUP, which resolves to no account, and
# Register-ScheduledTask fails with "No mapping between account names and
# security IDs was done". WindowsIdentity gives the name Windows accepts
# (HPO\ryer) on a domain member and a workgroup machine alike.
function Get-CurrentUserName {
  try { [System.Security.Principal.WindowsIdentity]::GetCurrent().Name }
  catch { "$env:COMPUTERNAME\$env:USERNAME" }
}

function Register-RunletTask {
  param(
    [string]$TaskName = 'runlet',
    [Parameter(Mandatory)][string]$NodeExe,
    [Parameter(Mandatory)][string]$RunnerScript,
    [Parameter(Mandatory)][string]$LogPath,
    [switch]$WhatIfOnly
  )
  # The merge is safe here: this runs in a fresh powershell.exe whose
  # $ErrorActionPreference is the default 'Continue', so the runner's stderr
  # reaches the log instead of killing the process.
  # .ToString() before Out-File: with the stderr merge, every line the runner
  # logs arrives as an ErrorRecord, and Out-File would write its whole
  # formatted block (CategoryInfo, FullyQualifiedErrorId, a blank line) around
  # each one. Stringifying leaves just the line the runner wrote.
  #
  # .ToString(), not "$_": the whole thing is one -Command argument already in
  # double quotes, and Windows argument parsing eats a nested pair, silently
  # turning { "$_" } into { $_ } -- which passes the ErrorRecord straight
  # through and undoes the fix. Single quotes only, below this line.
  $inner = "& '$NodeExe' '$RunnerScript' 2>&1 | ForEach-Object { `$_.ToString() } | " +
           "Out-File -FilePath '$LogPath' -Append -Encoding utf8"
  $argline = "-NoLogo -NonInteractive -NoProfile -WindowStyle Hidden -Command `"$inner`""
  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argline `
               -WorkingDirectory (Split-Path -Parent $RunnerScript)
  $user    = Get-CurrentUserName
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  # ExecutionTimeLimit 0 = no limit: the runner is meant to stay up, and the
  # three-day default would otherwise kill it mid-week.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
                -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 `
                -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $user `
                 -LogonType Interactive -RunLevel Limited
  if ($WhatIfOnly) {
    return [pscustomobject]@{ TaskName = $TaskName; Execute = 'powershell.exe'; Argument = $argline
                              Action = $action; Trigger = $trigger; Settings = $settings; Principal = $principal }
  }
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
  # Restart rather than start. A running instance keeps executing the command
  # it was registered with, so a re-run that changed it would leave the old
  # runner going. Stop first, because MultipleInstances IgnoreNew refuses a
  # second start and records the refusal as LastTaskResult (0x800710E0) --
  # the field SETUP.md tells people to check.
  if ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    foreach ($i in 1..20) {
      if ((Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') { break }
      Start-Sleep -Milliseconds 250
    }
  }
  Start-ScheduledTask -TaskName $TaskName
  Get-ScheduledTask -TaskName $TaskName
}

# `runlet` as a command, the way install.sh puts a symlink in ~/.local/bin.
function Install-RunletShim {
  param([Parameter(Mandatory)][string]$BinDir, [Parameter(Mandatory)][string]$NodeExe,
        [Parameter(Mandatory)][string]$RunnerScript)
  $cmd = "@echo off`r`n`"$NodeExe`" `"$RunnerScript`" %*`r`n"
  Write-TextNoBom -Path (Join-Path $BinDir 'runlet.cmd') -Text $cmd
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir".Trim(';'), 'User')
    return $true          # new terminals only; this session keeps its own Path
  }
  $false
}

if ($Lib) { return }

# =============================================================================
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Conf = Get-RunletConf
$EnvPath = Join-Path $Conf 'env'
$KeyPath = Join-Path $Conf 'relay.key'
$Runner  = Join-Path $Here 'win\runlet.mjs'

# --print-url: rebuild the connector URL from the env file an earlier run
# wrote, and nothing else -- no token, no network, no redeploy.
if ($PrintUrl) {
  if (-not (Test-Path $EnvPath)) { Write-Error "no ${EnvPath}: run .\install.ps1 first"; exit 1 }
  $url = Get-ConnectorUrl (Read-EnvFile $EnvPath)
  if (-not $url) { Write-Error "$EnvPath lacks RUNLET_WORKER_URL or RUNLET_URL_SECRET: re-run .\install.ps1"; exit 1 }
  Write-Output $url
  exit 0
}

# install.conf beside this script answers the questions in advance.
$confFile = Join-Path $Here 'install.conf'
if (Test-Path $confFile) {
  foreach ($kv in (Read-EnvFile $confFile).GetEnumerator()) {
    if (-not (Get-Item "env:$($kv.Key)" -ErrorAction SilentlyContinue)) {
      Set-Item "env:$($kv.Key)" $kv.Value
    }
  }
}

$existing = Read-EnvFile $EnvPath
$site = ConvertTo-SiteName $(if ($env:RUNLET_SITE) { $env:RUNLET_SITE } else { $env:COMPUTERNAME })
# A re-run must find the stack it made, even if the machine was renamed.
$workerName = if ($env:RUNLET_WORKER_NAME) { $env:RUNLET_WORKER_NAME }
              elseif ($existing.Contains('RUNLET_WORKER_NAME')) { $existing['RUNLET_WORKER_NAME'] }
              else { "runlet-$site" }
$dbName = if ($env:RUNLET_DB_NAME) { $env:RUNLET_DB_NAME }
          elseif ($existing.Contains('RUNLET_DB_NAME')) { $existing['RUNLET_DB_NAME'] }
          else { "runlet-$site" }

# --- 1. dependencies ---------------------------------------------------------
Write-Say "Checking dependencies"
$node = Get-Command node -ErrorAction SilentlyContinue
$nodeOk = $false
if ($node) {
  $major = [int](((& node -v) -replace '^v','') -split '\.')[0]
  if ($major -ge 20) { $nodeOk = $true }
}
if (-not $nodeOk) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Note 'installing Node 22 (winget)'
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    $node = Get-Command node -ErrorAction SilentlyContinue
  }
  if (-not $node) {
    Stop-Install 'Node 20+ is required. Install it from https://nodejs.org (LTS), reopen PowerShell, and re-run .\install.ps1'
  }
}
$NodeExe = (Get-Command node).Source
$Npm = Resolve-NodeTool -Name 'npm'
if (-not $Npm) { Stop-Install 'npm was not found beside node' }
Write-Note "node $(& node -v), npm $(& $Npm -v)"
Push-Location (Join-Path $Here 'worker')
try { & $Npm install --silent --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { Stop-Install 'npm install failed in worker/' } }
finally { Pop-Location }
$Wrangler = Join-Path $Here 'worker\node_modules\.bin\wrangler.cmd'
if (-not (Test-Path $Wrangler)) { Stop-Install "wrangler not found at $Wrangler" }

# --- 2. the token ------------------------------------------------------------
Write-Say "Cloudflare API token (site: $site -> Worker $workerName, database $dbName)"
$token = $env:CLOUDFLARE_API_TOKEN
if (-not $token -and $existing.Contains('CLOUDFLARE_API_TOKEN')) { $token = $existing['CLOUDFLARE_API_TOKEN'] }
if (-not $token) {
  Write-Host @'
    The installer needs a Cloudflare API token. Full steps are in SETUP.md;
    the short version:
      1. Sign in at https://dash.cloudflare.com (a free account is enough).
      2. Open https://dash.cloudflare.com/profile/api-tokens
         -> Create Token -> Create Custom Token (Get started).
      3. Name it runlet and add three permissions, all "Account":
            Workers Scripts   Edit
            D1                Edit
            Account Settings  Read
      4. Continue to summary -> Create Token -> copy it (shown once).
'@
  $secure = Read-Host -AsSecureString -Prompt '    Paste the token here and press Enter'
  $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
             [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
$env:CLOUDFLARE_API_TOKEN = $token
$verify = Invoke-Cf -Path '/user/tokens/verify' -Token $token
if (-not ($verify.success -and $verify.result.status -eq 'active')) { Stop-Install 'the token did not verify' }
$accounts = (Invoke-Cf -Path '/accounts?per_page=50' -Token $token).result
if (-not $accounts) { Stop-Install 'the token can see no accounts; it needs Account Settings: Read' }
if ($env:CLOUDFLARE_ACCOUNT_ID) { $accountId = $env:CLOUDFLARE_ACCOUNT_ID }
elseif (@($accounts).Count -eq 1) { $accountId = $accounts[0].id }
else {
  Write-Note 'The token can see several accounts:'
  $accounts | ForEach-Object { Write-Host "      $($_.id)  $($_.name)" }
  $accountId = Read-Host '    Account id to use'
}
$env:CLOUDFLARE_ACCOUNT_ID = $accountId
Write-Note "account $accountId ($((@($accounts) | Where-Object { $_.id -eq $accountId }).name))"

# --- 3. D1 -------------------------------------------------------------------
Write-Say "D1 database '$dbName'"
$db = (Invoke-Cf -Path "/accounts/$accountId/d1/database?name=$dbName&per_page=100" -Token $token).result |
        Where-Object { $_.name -eq $dbName } | Select-Object -First 1
if ($db) { $dbId = $db.uuid; Write-Note "exists: $dbId" }
else {
  $dbId = (Invoke-Cf -Path "/accounts/$accountId/d1/database" -Method POST -Body @{ name = $dbName } -Token $token).result.uuid
  Write-Note "created $dbId"
}
if ($dbId -notmatch '^[0-9a-f-]{36}$') { Stop-Install 'could not get a database id' }

# --- 4. wrangler config ------------------------------------------------------
Write-Say 'Writing worker/wrangler.jsonc'
$tpl = [System.IO.File]::ReadAllText((Join-Path $Here 'worker\wrangler.jsonc.template'))
$tpl = $tpl.Replace('__WORKER_NAME__', $workerName).Replace('__ACCOUNT_ID__', $accountId).
            Replace('__DB_NAME__', $dbName).Replace('__DB_ID__', $dbId)
Write-TextNoBom -Path (Join-Path $Here 'worker\wrangler.jsonc') -Text $tpl
Push-Location (Join-Path $Here 'worker')
try {
  & $Wrangler d1 execute $dbName --remote --file (Join-Path $Here 'schema.sql') | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-Install 'applying schema.sql failed' }
  # Columns added after the first release, for a database created before them.
  # ALTER TABLE is not idempotent in SQLite, so look first.
  $cols = (& $Wrangler d1 execute $dbName --remote --json --command 'PRAGMA table_info(commands);' |
             ConvertFrom-Json)[0].results.name
  foreach ($spec in @('background INTEGER NOT NULL DEFAULT 0', 'cancel INTEGER NOT NULL DEFAULT 0', 'runner TEXT')) {
    $col = $spec.Split(' ')[0]
    if ($cols -notcontains $col) {
      & $Wrangler d1 execute $dbName --remote --command "ALTER TABLE commands ADD COLUMN $spec;" | Out-Null
      if ($LASTEXITCODE -ne 0) { Stop-Install "adding the $col column failed" }
      Write-Note "added the $col column"
    }
  }
} finally { Pop-Location }
Write-Note 'schema applied'

# --- 5. secrets --------------------------------------------------------------
Write-Say 'Keys'
if (-not (Test-Path $Conf)) { New-Item -ItemType Directory -Force -Path $Conf | Out-Null }
if (-not (Test-Path $KeyPath) -or -not (Get-Item $KeyPath).Length) {
  Write-TextNoBom -Path $KeyPath -Text (New-HexSecret -Bytes 32)
  Protect-File -Path $KeyPath
  Write-Note 'generated relay.key'
} else { Write-Note 'relay.key exists, keeping it' }
# The runner's own credential: a bearer token for this machine's Worker, so
# the machine that executes commands holds no Cloudflare credential at all.
if ($existing.Contains('RUNLET_RUNNER_TOKEN') -and $existing['RUNLET_RUNNER_TOKEN']) {
  $runnerToken = $existing['RUNLET_RUNNER_TOKEN']; Write-Note 'runner token exists, keeping it'
} else {
  $runnerToken = New-HexSecret -Bytes 32; Write-Note 'generated the runner token'
}
if ($existing.Contains('RUNLET_URL_SECRET') -and $existing['RUNLET_URL_SECRET']) {
  $urlSecret = $existing['RUNLET_URL_SECRET']; Write-Note 'URL secret exists, keeping it'
} else {
  $n = if ($env:RUNLET_SECRET_WORDS) { [int]$env:RUNLET_SECRET_WORDS } else { 5 }
  $urlSecret = New-UrlSecret -WordsPath (Join-Path $Here 'words.txt') -Words $n
  Write-Note 'generated the URL secret'
}
Push-Location (Join-Path $Here 'worker')
try {
  ([System.IO.File]::ReadAllText($KeyPath)).Trim() | & $Wrangler secret put RUNLET_HMAC_KEY | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-Install 'setting RUNLET_HMAC_KEY failed' }
  $urlSecret | & $Wrangler secret put RUNLET_URL_SECRET | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-Install 'setting RUNLET_URL_SECRET failed' }
  $runnerToken | & $Wrangler secret put RUNLET_RUNNER_TOKEN | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-Install 'setting RUNLET_RUNNER_TOKEN failed' }
} finally { Pop-Location }
Write-Note 'Worker secrets set'

# --- 6. workers.dev subdomain, then deploy -----------------------------------
Write-Say 'Deploying the Worker'
$sub = (Invoke-Cf -Path "/accounts/$accountId/workers/subdomain" -Token $token).result.subdomain
if (-not $sub) {
  $want = "relay-$(New-HexSecret -Bytes 3)"
  Invoke-Cf -Path "/accounts/$accountId/workers/subdomain" -Method PUT -Body @{ subdomain = $want } -Token $token | Out-Null
  $sub = $want; Write-Note "registered workers.dev subdomain: $sub"
}
Push-Location (Join-Path $Here 'worker')
try { & $Wrangler deploy | Select-Object -Last 3 | ForEach-Object { Write-Note $_ }
      if ($LASTEXITCODE -ne 0) { Stop-Install 'wrangler deploy failed' } }
finally { Pop-Location }
$workerUrl = "https://$workerName.$sub.workers.dev"

# --- 7. local config ---------------------------------------------------------
Write-Say "Writing $EnvPath"
# CLOUDFLARE_API_TOKEN is deliberately NOT written here. The runner reaches
# its queue through the Worker now, and a D1 API token is account-wide: one
# left on every machine would reach every other machine's queue. Provisioning
# needs it, this machine does not, so a re-run asks for it again.
Write-EnvFile -Path $EnvPath -Values ([ordered]@{
  CLOUDFLARE_ACCOUNT_ID = $accountId
  RUNLET_SITE           = $site
  RUNLET_WORKER_NAME    = $workerName
  RUNLET_DB_NAME        = $dbName
  RUNLET_DB_ID          = $dbId
  RUNLET_URL_SECRET     = $urlSecret
  RUNLET_WORKER_URL     = $workerUrl
  RUNLET_RUNNER_TOKEN   = $runnerToken
  RUNLET_POLL           = 5
  RUNLET_CMD_TIMEOUT    = 600
  RUNLET_KEY_FILE       = $KeyPath
})
$binDir = Join-Path $Conf 'bin'
if (Install-RunletShim -BinDir $binDir -NodeExe $NodeExe -RunnerScript $Runner) {
  Write-Note "added $binDir to your PATH (new terminals only)"
}
New-Item -ItemType Directory -Force -Path (Join-Path $Conf 'skills') | Out-Null

# --- 8. smoke test -----------------------------------------------------------
Write-Say 'Smoke test'
$mcp = "$workerUrl/$urlSecret/mcp"
$queue = @{ jsonrpc = '2.0'; id = 1; method = 'tools/call'
            params = @{ name = 'run_command'; arguments = @{ command = 'echo runlet-ok'; wait = 0 } } }
$resp = $null
# A fresh deploy takes a few seconds to reach every edge.
foreach ($i in 1..12) {
  try { $resp = Invoke-RestMethod -Uri $mcp -Method POST -ContentType 'application/json' `
                  -Body ($queue | ConvertTo-Json -Depth 6); break }
  catch { Write-Note "waiting for the deploy to propagate ($($i*5)s)"; Start-Sleep -Seconds 5 }
}
if (-not $resp) { Stop-Install "the Worker did not answer at $mcp after a minute" }
$rid = [regex]::Match($resp.result.content[0].text, '#(\d+)').Groups[1].Value
if (-not $rid) { Stop-Install "unexpected Worker reply: $($resp.result.content[0].text)" }
$once = Invoke-Native -Exe $NodeExe -Arguments @($Runner, '--once')
$once.Output | ForEach-Object { Write-Note $_ }
$get = @{ jsonrpc = '2.0'; id = 2; method = 'tools/call'
          params = @{ name = 'get_result'; arguments = @{ id = [int]$rid; wait = 30 } } }
$got = (Invoke-RestMethod -Uri $mcp -Method POST -ContentType 'application/json' `
          -Body ($get | ConvertTo-Json -Depth 6)).result.content[0].text
if ($got -notmatch 'runlet-ok') { Stop-Install "smoke test failed; the runner did not produce the result: $got" }
Write-Note "queued #$rid, ran it, read the output back: OK"

# --- 9. the service ----------------------------------------------------------
$logPath = Join-Path $Conf 'runner.log'
if ($NoService) {
  Write-Say "Not registering the task (-NoService). Run it with: node `"$Runner`""
} else {
  Write-Say 'Registering the runner as a Scheduled Task'
  $task = Register-RunletTask -NodeExe $NodeExe -RunnerScript $Runner -LogPath $logPath
  Write-Note "task 'runlet': $($task.State); starts at logon"
  Write-Note "log: $logPath"
}

# --- 10. hand the URL to the person ------------------------------------------
$connectors = 'https://claude.ai/settings/connectors'
$clip = $false
try { Set-Clipboard -Value $mcp; $clip = $true } catch { }
try { Start-Process $connectors | Out-Null; $opened = $true } catch { $opened = $false }

Write-Say 'Done'
Write-Host @"
    Connector URL (treat it as a password; it is the only credential):

        $mcp

"@
if ($clip) { Write-Note 'It is on your clipboard.' } else { Write-Note 'Copy it from above.' }
if ($opened) { Write-Note "Claude's connectors page is opening in your browser (sign in if it asks)." }
else { Write-Note "Open $connectors in a browser (sign in if it asks)." }
Write-Host @"
    There: Add custom connector -> paste the URL -> no authentication -> save.
    Then ask Claude to run a command, e.g. "run hostname on my machine".

    Status:      runlet status        (runlet --help for the rest)
    Skills:      link SKILL.md files into $Conf\skills\ for assistants to find
    Config:      $EnvPath   (runner token, URL secret)   $KeyPath
    Runner log:  Get-Content -Wait "$logPath"
    Re-run this script any time; it keeps existing keys and ids.
"@
