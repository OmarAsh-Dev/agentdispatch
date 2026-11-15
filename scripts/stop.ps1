param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
$bridgeRoot=(Resolve-Path -LiteralPath $Root).Path
foreach($service in @(@{Name='bridge';Script='src\server.mjs'},@{Name='opencode';Script='node_modules\opencode-windows-x64\bin\opencode.exe'})) {
  $pidFile=Join-Path $bridgeRoot ".state\$($service.Name).pid"
  if(-not(Test-Path -LiteralPath $pidFile)){continue}
  $bridgePid=[int](Get-Content -LiteralPath $pidFile)
  $bridgeProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid"
  if(-not $bridgeProcess){continue}
  $expected=Join-Path $bridgeRoot $service.Script
  if(($service.Name -eq 'bridge' -and $bridgeProcess.CommandLine.Contains($expected)) -or ($service.Name -eq 'opencode' -and $bridgeProcess.ExecutablePath -eq $expected)){
    Stop-Process -Id $bridgePid -ErrorAction Stop
    Write-Output "Stopped $($service.Name) PID $bridgePid"
  }else{throw "PID $bridgePid does not match this bridge installation"}
}
