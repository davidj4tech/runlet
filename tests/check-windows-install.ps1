<#
  check-windows-install.ps1 -- install.ps1's helpers, without installing
  anything or touching Cloudflare.

      powershell -ExecutionPolicy Bypass -File tests\check-windows-install.ps1

  install.ps1 -Lib defines its functions and returns before the install runs,
  so everything below is the real code, not a copy of it.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
. (Join-Path $Root 'install.ps1') -Lib

$script:Failed = 0
function Test-Case {
  param([string]$Name, [scriptblock]$Body)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try { & $Body; Write-Host ("  ok    {0} ({1:N1}s)" -f $Name, $sw.Elapsed.TotalSeconds) }
  catch {
    if ($_.Exception.Message -like 'SKIP: *') {
      Write-Host ("  skip  {0} -- {1}" -f $Name, $_.Exception.Message.Substring(6)) -ForegroundColor Yellow
      return
    }
    $script:Failed++
    Write-Host ("  FAIL  {0} ({1:N1}s)" -f $Name, $sw.Elapsed.TotalSeconds) -ForegroundColor Red
    Write-Host ("        " + $_.Exception.Message)
  }
}
function Assert-Equal { param($Expected, $Actual, [string]$What = 'value')
  if ($Expected -ne $Actual) { throw "$What`: expected '$Expected', got '$Actual'" } }
function Assert-True { param([bool]$Cond, [string]$What) if (-not $Cond) { throw $What } }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("runlet-ps-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {

Test-Case 'site names are safe for Worker and database names' {
  Assert-Equal 'my-pc'  (ConvertTo-SiteName 'MY_PC')
  Assert-Equal 'hpo'    (ConvertTo-SiteName 'hpo')
  Assert-Equal 'a--b'   (ConvertTo-SiteName '--a  b--')   # one dash per character, as `tr -c` gives
  Assert-Equal 'site'   (ConvertTo-SiteName '')
  Assert-Equal 'site'   (ConvertTo-SiteName '___')
  $long = ConvertTo-SiteName ('x' * 60)
  Assert-True ($long.Length -le 30) "a 60-character name was not truncated: $($long.Length)"
  Assert-True ($long -match '^[a-z0-9-]+$') "unsafe characters survived: $long"
}

# The env file is read by win\runlet.mjs, whose parser anchors at ^\s*KEY=.
# PowerShell's -Encoding UTF8 writes a BOM, which would hide the first key.
Test-Case 'the env file is UTF-8 with no BOM' {
  $f = Join-Path $tmp 'env'
  Write-EnvFile -Path $f -Values ([ordered]@{ CLOUDFLARE_API_TOKEN = 'tok'; RUNLET_POLL = 5 })
  $bytes = [IO.File]::ReadAllBytes($f)
  $bom = ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  Assert-True (-not $bom) 'the env file starts with a UTF-8 BOM'
  $back = Read-EnvFile $f
  Assert-Equal 'tok' $back['CLOUDFLARE_API_TOKEN'] 'the first key did not survive a round trip'
  Assert-Equal '5'   $back['RUNLET_POLL']
}

Test-Case 'the env file round-trips through the runner parser' {
  $f = Join-Path $tmp 'env2'
  Write-EnvFile -Path $f -Values ([ordered]@{ RUNLET_WORKER_URL = 'https://x.y.workers.dev'
                                              RUNLET_URL_SECRET = 'a-b-c-d-e' })
  $nodeExe = if ($env:RUNLET_TEST_NODE) { $env:RUNLET_TEST_NODE.Trim() }
             else { (Get-Command node -ErrorAction SilentlyContinue).Source }
  if (-not $nodeExe) { throw 'SKIP: no node on PATH (set RUNLET_TEST_NODE to point at one)' }
  # The runner's own regex, run over the file install.ps1 just wrote.
  $js = @'
const { readFileSync } = require("node:fs");
const out = {};
for (const line of readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m) out[m[1]] = m[2].replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
}
process.stdout.write(JSON.stringify(out));
'@
  # Via a file, not `node -e`: PowerShell 5.1 mangles a multi-line argument
  # on its way to a native executable.
  $jsFile = Join-Path $tmp 'parse.js'
  Write-TextNoBom -Path $jsFile -Text $js
  $raw = (& $nodeExe $jsFile $f) -join ''
  if (-not $raw) { throw "the parser printed nothing (node: $nodeExe)" }
  $parsed = $raw | ConvertFrom-Json
  Assert-Equal 'https://x.y.workers.dev' $parsed.RUNLET_WORKER_URL "the runner could not read the URL back from: $raw" 
  Assert-Equal 'a-b-c-d-e' $parsed.RUNLET_URL_SECRET
}

Test-Case 'the connector URL is rebuilt from the env file' {
  $f = Join-Path $tmp 'env3'
  Write-EnvFile -Path $f -Values ([ordered]@{ RUNLET_WORKER_URL = 'https://w.s.workers.dev'
                                              RUNLET_URL_SECRET = 'one-two-three-four-five' })
  Assert-Equal 'https://w.s.workers.dev/one-two-three-four-five/mcp' (Get-ConnectorUrl (Read-EnvFile $f))
  Assert-True ($null -eq (Get-ConnectorUrl (Read-EnvFile (Join-Path $tmp 'nope')))) 'a missing env file should give no URL'
}

Test-Case 'the HMAC key is 64 hex characters and never repeats' {
  $a = New-HexSecret -Bytes 32; $b = New-HexSecret -Bytes 32
  Assert-True ($a -match '^[0-9a-f]{64}$') "not 64 hex characters: $a"
  Assert-True ($a -ne $b) 'two keys came out identical'
}

Test-Case 'the URL secret is words from the list, and spreads over it' {
  $words = Join-Path $Root 'words.txt'
  $s = New-UrlSecret -WordsPath $words -Words 5
  $parts = $s -split '-'
  Assert-Equal 5 $parts.Count "expected 5 words, got '$s'"
  $list = [IO.File]::ReadAllLines($words) | Where-Object { $_.Trim() }
  foreach ($p in $parts) { Assert-True ($list -contains $p) "'$p' is not in words.txt" }
  # Rejection sampling, not modulo: 400 draws must not pile into the low end.
  $idx = 1..400 | ForEach-Object { Get-RandomIndex -Bound $list.Count }
  $high = @($idx | Where-Object { $_ -ge ($list.Count / 2) }).Count
  Assert-True ($high -gt 140 -and $high -lt 260) "draws look biased: $high of 400 in the upper half"
}

Test-Case 'a short word list falls back to hex' {
  $short = Join-Path $tmp 'short.txt'
  Set-Content -Path $short -Value (1..10 | ForEach-Object { "w$_" })
  Assert-True ((New-UrlSecret -WordsPath $short -Words 5) -match '^[0-9a-f]{48}$') 'no hex fallback'
  Assert-True ((New-UrlSecret -WordsPath (Join-Path $tmp 'absent.txt') -Words 5) -match '^[0-9a-f]{48}$') 'no hex fallback for a missing list'
}

Test-Case 'fewer than four words is refused' {
  $s = New-UrlSecret -WordsPath (Join-Path $Root 'words.txt') -Words 2
  Assert-Equal 5 ($s -split '-').Count 'a 2-word secret was accepted'
}

# The task definition, built but not registered: the shape is what matters.
Test-Case 'the scheduled task runs the runner hidden, at logon, without a time limit' {
  $t = Register-RunletTask -NodeExe 'C:\node\node.exe' -RunnerScript 'C:\repo\win\runlet.mjs' `
         -LogPath 'C:\conf\runner.log' -WhatIfOnly
  Assert-Equal 'powershell.exe' $t.Execute
  Assert-True ($t.Argument -match '-WindowStyle Hidden') 'the console window would show at every logon'
  Assert-True ($t.Argument -match [regex]::Escape('C:\repo\win\runlet.mjs')) 'the runner script is not in the command'
  Assert-True ($t.Argument -match [regex]::Escape('C:\conf\runner.log')) 'nothing would be logged'
  Assert-Equal 'PT0S' $t.Settings.ExecutionTimeLimit 'a time limit would kill the runner mid-week'
  Assert-True ($t.Settings.RestartCount -ge 1) 'the runner would not be restarted after a crash'
  Assert-Equal 'IgnoreNew' $t.Settings.MultipleInstances 'two runners could poll the same queue'
  Assert-True ($t.Trigger.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') 'the task does not start at logon'
  Assert-Equal 'Limited' $t.Principal.RunLevel 'the runner must not run elevated'
  # A workgroup machine has USERDOMAIN=WORKGROUP, which maps to no account and
  # makes Register-ScheduledTask fail outright.
  $whoami = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  Assert-Equal $whoami $t.Principal.UserId 'the principal is not an identity Windows can resolve'
  Assert-True ($t.Principal.UserId -notmatch 'WORKGROUP') 'WORKGROUP is not a real domain'
}

Test-Case 'the runlet shim calls the runner and forwards its arguments' {
  $bin = Join-Path $tmp 'bin'
  Install-RunletShim -BinDir $bin -NodeExe 'C:\node\node.exe' -RunnerScript 'C:\repo\win\runlet.mjs' | Out-Null
  $cmd = [IO.File]::ReadAllText((Join-Path $bin 'runlet.cmd'))
  Assert-True ($cmd -match [regex]::Escape('"C:\node\node.exe" "C:\repo\win\runlet.mjs" %*')) "shim is wrong: $cmd"
}

} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if ($script:Failed) { Write-Host "check-windows-install: $script:Failed case(s) failed"; exit 1 }
Write-Host 'check-windows-install: all cases pass'
exit 0
