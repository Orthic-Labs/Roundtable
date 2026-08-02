param(
  [Parameter(Mandatory = $true)][string]$NodeId,
  [Parameter(Mandatory = $true)][string]$NodeToken,
  [string]$HubUrl = 'wss://citadel.spoares.com/node/connect'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$configDir = Join-Path $env:APPDATA 'Roundtable'
$dataDir = Join-Path $env:LOCALAPPDATA 'Roundtable'
$binDir = Join-Path $env:LOCALAPPDATA 'Roundtable\bin'
$binary = Join-Path $binDir 'citadel-node.exe'
$config = Join-Path $configDir 'config.json'
$token = Join-Path $configDir 'node.token'
$launcher = Join-Path $configDir 'run-node.ps1'
$logDir = Join-Path $dataDir 'logs'
$stdoutLog = Join-Path $logDir 'node.out.log'
$stderrLog = Join-Path $logDir 'node.err.log'
$taskName = 'OrthicLabs-Citadel-Node'
$codex = (Get-Command codex.cmd -ErrorAction SilentlyContinue).Source
if (-not $codex) { throw 'codex.cmd was not found on PATH; install the Codex CLI before installing the node.' }
$cmd = $env:ComSpec
if (-not $cmd) { throw 'COMSPEC is unavailable; cannot launch the Codex command wrapper.' }
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $configDir,$dataDir,$binDir,$logDir | Out-Null
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
$deadline = (Get-Date).AddSeconds(10)
do {
  $nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'citadel-node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$binary*" })
  if ($nodeProcesses.Count -gt 0) {
    $nodeProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 250
  }
} while ($nodeProcesses.Count -gt 0 -and (Get-Date) -lt $deadline)
if ($nodeProcesses.Count -gt 0) {
  throw "Could not stop the existing node process at $binary"
}
& cargo build --release -p citadel-node --manifest-path (Join-Path $repoRoot 'Cargo.toml')
Copy-Item (Join-Path $repoRoot 'target\release\citadel-node.exe') $binary -Force
Set-Content -NoNewline -Encoding ascii -Path $token -Value $NodeToken
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $configDir /inheritance:r /grant:r "*${owner}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not protect $configDir" }
& icacls $dataDir /inheritance:r /grant:r "*${owner}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not protect $dataDir" }
@{
  hub_url=$HubUrl; node_id=$NodeId; hostname=$env:COMPUTERNAME; os='windows'; version='0.1.0'
  ipc_socket_path="\\.\pipe\roundtable-$NodeId"; state_path=(Join-Path $dataDir 'state.json')
  # The Microsoft Store codex.exe cannot be spawned from a scheduled task (ERROR_ACCESS_DENIED).
  # cmd.exe launches pnpm's .cmd shim, whose stdio remains connected to the node app-server adapter.
  codex_command=@($cmd,'/d','/c',$codex,'app-server'); codex_cwd=$null; reconnect_base_ms=1000; heartbeat_ms=15000; heartbeat_offline_after_ms=45000
} | ConvertTo-Json | Set-Content -Encoding utf8 $config
& icacls $config /inheritance:r /grant:r "*${owner}:F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not protect $config" }
@"
`$ErrorActionPreference = 'Stop'
# A machine-wide RUST_LOG (quieter than info) silences the node's own connect/disconnect lines,
# leaving the operator unable to tell a connected node from a wedged one. Pin the service's filter;
# CITADEL_NODE_LOG overrides it for debugging.
`$env:RUST_LOG = if (`$env:CITADEL_NODE_LOG) { `$env:CITADEL_NODE_LOG } else { 'info' }
`$env:CITADEL_NODE_CONFIG = '$config'
`$env:CITADEL_NODE_TOKEN_FILE = '$token'
`$process = Start-Process -FilePath '$binary' -WorkingDirectory '$dataDir' -RedirectStandardOutput '$stdoutLog' -RedirectStandardError '$stderrLog' -PassThru -Wait
exit `$process.ExitCode
"@ | Set-Content -Encoding utf8 $launcher
& icacls $launcher /inheritance:r /grant:r "*${owner}:F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not protect $launcher" }
$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`"" -WorkingDirectory $dataDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -Hidden -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed and started $taskName. Logs: $logDir"
