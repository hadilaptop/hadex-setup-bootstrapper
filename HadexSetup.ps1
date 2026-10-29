$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$BundleRoot = $PSScriptRoot
$PayloadRoot = Join-Path $BundleRoot 'payload'
$RuntimeRoot = Join-Path $BundleRoot 'runtime'
$NodeExe = Join-Path $RuntimeRoot 'node.exe'
$StateRoot = Join-Path $BundleRoot '.runtime-state'
$ChromiumDir = Join-Path $PayloadRoot 'Hadex Chromium'
$KeyDir = Join-Path $PayloadRoot 'apps\key-creator'
$TunnelDir = Join-Path $PayloadRoot 'apps\tunnels'
$PluginDir = Join-Path $PayloadRoot 'apps\plugins'
$KeyFolder = if (Test-Path 'E:\') { 'E:\hadex\Hadex gpt2' } else { Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Hadex' }
$KeyFile = Join-Path $KeyFolder 'CONTROL_PLANE_API_KEY.txt'
$TunnelIdFile = Join-Path $StateRoot 'CONTROL_PLANE_TUNNEL_ID.txt'
$PluginMarker = Join-Path $StateRoot 'plugin-success.json'
$BrowserProcess = $null
$Completed = $false

function Invoke-HadexWizard {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Directory
    )
    Write-Host ''
    Write-Host ('=== ' + $Label + ' ===') -ForegroundColor Cyan
    Push-Location $Directory
    try {
        & $NodeExe 'src\wizard.js'
        $code = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($code -ne 0) {
        throw "$Label ended with exit code $code."
    }
}

try {
    Write-Host 'Hadex one-time setup' -ForegroundColor Cyan
    Write-Host 'Sign in yourself in the Hadex Chromium window. Do not share your password or API key.' -ForegroundColor Gray

    foreach ($required in @(
        $NodeExe,
        (Join-Path $ChromiumDir 'main.js'),
        (Join-Path $ChromiumDir 'node_modules\electron\dist\electron.exe'),
        (Join-Path $KeyDir 'src\wizard.js'),
        (Join-Path $TunnelDir 'src\wizard.js'),
        (Join-Path $PluginDir 'src\wizard.js')
    )) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "The setup package is incomplete; required file not found: $required"
        }
    }

    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $StateRoot 'LocalAppData') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $StateRoot 'RoamingAppData') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $StateRoot 'Playwright') -Force | Out-Null
    New-Item -ItemType Directory -Path $KeyFolder -Force | Out-Null

    # All browser sessions, Electron user data, logs, caches, and tunnel metadata
    # are redirected into the extracted temporary bundle. The key folder is durable.
    $env:LOCALAPPDATA = Join-Path $StateRoot 'LocalAppData'
    $env:APPDATA = Join-Path $StateRoot 'RoamingAppData'
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $StateRoot 'Playwright'
    $env:npm_config_cache = Join-Path $StateRoot 'npm-cache'
    $env:HADEX_KEY_DIR = $KeyFolder
    $env:HADEX_TUNNEL_ID_FILE = $TunnelIdFile
    $env:PATH = "$RuntimeRoot;$RuntimeRoot\node_modules\npm\bin;$env:PATH"

    if (-not (Test-Path -LiteralPath $KeyFile)) {
        # The existing Key Creator writes the API key with restrictive permissions.
        # Do not create backup copies: if a key already exists, reuse it and skip this step.
        Write-Host 'Preparing the API key folder: ' -NoNewline
        Write-Host $KeyFolder -ForegroundColor Gray
    }
    else {
        $existingKey = (Get-Content -LiteralPath $KeyFile -Raw -ErrorAction Stop).Trim()
        if ([string]::IsNullOrWhiteSpace($existingKey)) {
            throw "An API key file already exists but is empty: $KeyFile. It was not overwritten."
        }
        Write-Host 'An existing API key file was found; it will be preserved.' -ForegroundColor Yellow
    }

    $listener = Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        throw 'Port 9223 is already in use. Close the other Hadex Chromium instance and run setup again.'
    }

    Write-Host 'Starting Hadex Chromium...' -ForegroundColor Cyan
    $electronExe = Join-Path $ChromiumDir 'node_modules\electron\dist\electron.exe'
    $BrowserProcess = Start-Process -FilePath $electronExe -ArgumentList @('.') -WorkingDirectory $ChromiumDir -PassThru
    $deadline = (Get-Date).AddSeconds(60)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if ($BrowserProcess.HasExited) {
            throw "Hadex Chromium exited during startup (code $($BrowserProcess.ExitCode))."
        }
        try {
            $version = Invoke-RestMethod -Uri 'http://127.0.0.1:9223/json/version' -TimeoutSec 2
            if ($version.webSocketDebuggerUrl) { $ready = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
        throw 'Hadex Chromium did not expose its local automation endpoint within 60 seconds.'
    }

    if (-not (Test-Path -LiteralPath $KeyFile)) {
        Invoke-HadexWizard -Label 'Step 1/3 — Create and save API key' -Directory $KeyDir
        if (-not (Test-Path -LiteralPath $KeyFile)) {
            throw "The key-creation window closed without saving the API key. Expected file: $KeyFile"
        }
        $newKey = (Get-Content -LiteralPath $KeyFile -Raw -ErrorAction Stop).Trim()
        if ([string]::IsNullOrWhiteSpace($newKey)) {
            throw "The API key file is empty: $KeyFile"
        }
        Write-Host 'API key saved. Its value will not be printed.' -ForegroundColor Green
    }
    else {
        Write-Host 'Step 1/3 skipped: using the existing API key file.' -ForegroundColor Green
    }

    Remove-Item -LiteralPath $TunnelIdFile -Force -ErrorAction SilentlyContinue
    Invoke-HadexWizard -Label 'Step 2/3 — Create tunnel and capture its ID' -Directory $TunnelDir
    if (-not (Test-Path -LiteralPath $TunnelIdFile)) {
        throw 'The tunnel setup ended without saving a complete tunnel ID. The temporary session will be cleaned; the API key is preserved.'
    }
    $tunnelId = (Get-Content -LiteralPath $TunnelIdFile -Raw -ErrorAction Stop).Trim()
    if ($tunnelId -notmatch '^tunnel_[0-9a-f]{8,64}$') {
        throw 'The captured tunnel ID failed validation. The API key is preserved.'
    }
    Write-Host 'Tunnel ID captured for this setup session.' -ForegroundColor Green

    Remove-Item -LiteralPath $PluginMarker -Force -ErrorAction SilentlyContinue
    $env:HADEX_STAGE_MARKER = $PluginMarker
    Invoke-HadexWizard -Label 'Step 3/3 — Add Hadex MCP server to ChatGPT' -Directory $PluginDir
    if (-not (Test-Path -LiteralPath $PluginMarker)) {
        throw 'The plugin setup window closed without confirming completion. The API key is preserved.'
    }
    $marker = Get-Content -LiteralPath $PluginMarker -Raw | ConvertFrom-Json
    if ($marker.stage -ne 'plugin') {
        throw 'The MCP setup success marker is invalid.'
    }

    # The one-time setup intentionally retains only the API key file in the
    # durable Hadex folder. Remove known legacy setup artifacts after success.
    Remove-Item -LiteralPath (Join-Path $KeyFolder 'CONTROL_PLANE_TUNNEL_ID.txt') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $KeyFolder 'CONTROL_PLANE_API_KEY.backup.txt') -Force -ErrorAction SilentlyContinue

    $Completed = $true
    Write-Host ''
    Write-Host 'Hadex setup completed successfully.' -ForegroundColor Green
    Write-Host ('Retained API key file: ' + $KeyFile) -ForegroundColor Gray
    Write-Host 'Temporary browser/session data will now be removed.' -ForegroundColor Gray
}
finally {
    # Stop only the Hadex Chromium process started by this setup. Its profile and
    # all logs/caches/tunnel metadata live under the temporary bundle.
    try {
        $chromiumProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -eq 'electron.exe' -and
                ($_.CommandLine -like '*Hadex Chromium*' -or $_.CommandLine -like '*remote-debugging-port=9223*')
            }
        foreach ($p in $chromiumProcesses) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {}
    if ($BrowserProcess -and -not $BrowserProcess.HasExited) {
        Stop-Process -Id $BrowserProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $StateRoot) {
        Remove-Item -LiteralPath $StateRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if (-not $Completed) {
    throw 'Hadex setup did not complete.'
}
