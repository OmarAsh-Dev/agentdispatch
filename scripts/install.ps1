#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'AgentDispatch'),
    [string]$ProviderId,
    [string]$ModelId
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'AgentDispatch requires Windows x64.' }
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$npm = (Get-Command npm.cmd -CommandType Application | Select-Object -First 1).Source
& $node -e 'process.exit(process.arch === "x64" && Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'
if ($LASTEXITCODE -ne 0) { throw 'Install the Windows x64 build of Node.js 24 or newer.' }

$hasProvider = -not [string]::IsNullOrWhiteSpace($ProviderId)
if ($hasProvider -ne (-not [string]::IsNullOrWhiteSpace($ModelId))) {
    throw 'Supply ProviderId and ModelId together, or set both in the installed config.'
}

$source = Split-Path -Parent $PSScriptRoot
$installPath = [IO.Path]::TrimEndingDirectorySeparator(
    [IO.Path]::GetFullPath($Destination, (Get-Location).ProviderPath)
)
if (Get-Item -LiteralPath $installPath -Force -ErrorAction SilentlyContinue) {
    throw "Destination already exists: $installPath. Choose a new folder."
}
$parent = Split-Path -Parent $installPath
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$staging = Join-Path $parent ".kanzo-install-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    $files = @('.npmrc', '.gitignore', 'package.json', 'package-lock.json', 'README.md',
        'LICENSE', 'bridge.config.example.json', 'scripts', 'src', 'tests')
    foreach ($file in $files) {
        Copy-Item -LiteralPath (Join-Path $source $file) -Destination $staging -Recurse
    }

    $config = Get-Content -LiteralPath (Join-Path $source 'bridge.config.example.json') -Raw |
        ConvertFrom-Json -AsHashtable
    if ($hasProvider) {
        $config.model.providerID = $ProviderId.Trim()
        $config.model.modelID = $ModelId.Trim()
    }
    $config | ConvertTo-Json -Depth 10 |
        Set-Content -LiteralPath (Join-Path $staging 'bridge.config.json') -Encoding utf8

    Push-Location -LiteralPath $staging
    try {
        & $npm ci --ignore-scripts --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Check access to the npm registry and retry.' }
        $binaries = @(
            'node_modules\opencode-windows-x64\bin\opencode.exe',
            'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
        )
        foreach ($binary in $binaries) {
            if (-not (Test-Path -LiteralPath (Join-Path $staging $binary) -PathType Leaf)) {
                throw "The package install did not supply $binary."
            }
        }
    } finally {
        Pop-Location
    }

    $shim = "@echo off`r`n" + 'node "%~dp0scripts\bridge.mjs" %*' + "`r`n"
    [IO.File]::WriteAllText((Join-Path $staging 'agentdispatch.cmd'), $shim)
    [IO.Directory]::Move($staging, $installPath)
} finally {
    if (Test-Path -LiteralPath $staging -PathType Container) {
        # Clean up only the explicitly created sibling directory owned by this run.
        $resolved = (Resolve-Path -LiteralPath $staging).ProviderPath
        if ($resolved -eq $staging -and (Split-Path -Parent $resolved) -eq $parent -and
            (Split-Path -Leaf $resolved) -match '^\.kanzo-install-[0-9a-f-]{36}$') {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}

Write-Output "Installed AgentDispatch at $installPath"
Write-Output "Review the settings in $installPath\bridge.config.json, then run:"
Write-Output "& '$($installPath.Replace("'", "''"))\agentdispatch.cmd' start"
