<#
  check-windows-install.ps1 — install.ps1, which is now only a bootstrap.

      powershell -ExecutionPolicy Bypass -File tests\check-windows-install.ps1

  Everything install.ps1 used to decide -- names, secrets, the env file, the
  Scheduled Task -- moved into install.mjs and is covered by
  tests\check-install.mjs, which runs on every platform. What is left here is
  the one thing that cannot be written in Node: finding Node.

  install.ps1 -Lib defines its functions and returns before installing, so
  this tests the real script rather than a copy of it.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
. (Join-Path $Root 'install.ps1') -Lib

$script:Failed = 0
function Test-Case {
  param([string]$Name, [scriptblock]$Body)
  try { & $Body; Write-Host "  ok    $Name" }
  catch { $script:Failed++; Write-Host "  FAIL  $Name" -ForegroundColor Red
          Write-Host ("        " + $_.Exception.Message) }
}
function Assert-True { param([bool]$Cond, [string]$What) if (-not $Cond) { throw $What } }

Test-Case 'a usable Node is found and returned' {
  $node = Install-NodeIfMissing
  Assert-True ([bool]$node) 'no Node path came back'
  Assert-True (Test-Path $node) "the returned path does not exist: $node"
  $major = [int](((& $node -v) -replace '^v','') -split '\.')[0]
  Assert-True ($major -ge 20) "Node $major is older than the minimum"
}

Test-Case 'the bootstrap hands over and decides nothing itself' {
  $src = [IO.File]::ReadAllText((Join-Path $Root 'install.ps1'))
  Assert-True ($src -match 'install\.mjs') 'it never calls install.mjs'
  foreach ($gone in @('d1/database', 'wrangler', 'SASONICA_URL_SECRET', 'Register-ScheduledTask')) {
    Assert-True ($src -notmatch [regex]::Escape($gone)) "provisioning is back in install.ps1: $gone"
  }
}

Test-Case '-Lib installs nothing' {
  # Dot-sourcing above already returned; if it had not, there would be a task.
  $src = [IO.File]::ReadAllText((Join-Path $Root 'install.ps1'))
  Assert-True ($src -match 'if \(\$Lib\) \{ return \}') 'the -Lib guard is gone'
}

if ($script:Failed) { Write-Host "check-windows-install: $script:Failed case(s) failed"; exit 1 }
Write-Host 'check-windows-install: all cases pass'
exit 0
