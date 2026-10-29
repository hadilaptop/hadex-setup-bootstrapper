# Hadex one-time setup bootstrapper
# Usage:
#   irm https://raw.githubusercontent.com/hadilaptop/hadex-setup-bootstrapper/main/bootstrap.ps1 | iex
#
# Downloads the latest signed-by-checksum release bundle into a unique temporary
# directory, runs HadexSetup.ps1, and removes the complete temporary bundle.

$ErrorActionPreference = 'Stop'
$Repo = 'hadilaptop/hadex-setup-bootstrapper'
$AssetName = 'hadex-setup-win-x64.zip'
$ChecksumName = "$AssetName.sha256"
$TempRoot = Join-Path $env:TEMP ('HadexSetup-' + [guid]::NewGuid().ToString('N'))
$ZipPath = Join-Path $TempRoot $AssetName
$ChecksumPath = Join-Path $TempRoot $ChecksumName
$ExtractPath = Join-Path $TempRoot 'package'

try {
    Write-Host ''
    Write-Host 'Hadex one-time setup' -ForegroundColor Cyan
    Write-Host 'The browser profile and session data are temporary.' -ForegroundColor Gray
    Write-Host 'The API key is saved locally and is not uploaded to GitHub.' -ForegroundColor Gray
    Write-Host ''

    if ($env:OS -ne 'Windows_NT') {
        throw 'This setup bundle is for Windows.'
    }

    New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
    $headers = @{ 'Accept' = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
    $releaseUrl = "https://api.github.com/repos/$Repo/releases/latest"
    Write-Host 'Checking for the latest published setup bundle...'
    $release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers

    $asset = @($release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1)
    $checksumAsset = @($release.assets | Where-Object { $_.name -eq $ChecksumName } | Select-Object -First 1)
    if ($asset.Count -eq 0 -or $checksumAsset.Count -eq 0) {
        throw "Release '$($release.tag_name)' is missing the setup ZIP or its SHA-256 checksum. Publish both assets first."
    }

    Write-Host "Downloading version $($release.tag_name)..."
    Invoke-WebRequest -Uri $asset[0].browser_download_url -OutFile $ZipPath
    Invoke-WebRequest -Uri $checksumAsset[0].browser_download_url -OutFile $ChecksumPath

    if ($asset[0].size -and (Get-Item $ZipPath).Length -ne $asset[0].size) {
        throw 'The downloaded bundle size does not match GitHub release metadata.'
    }

    $checksumText = (Get-Content -LiteralPath $ChecksumPath -Raw).Trim()
    if ($checksumText -notmatch '^([0-9a-fA-F]{64})\s+') {
        throw 'The release SHA-256 checksum file has an invalid format.'
    }
    $expectedHash = $Matches[1].ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw 'SHA-256 verification failed. The downloaded setup bundle will not be executed.'
    }

    Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractPath -Force
    $setupScript = Join-Path $ExtractPath 'HadexSetup.ps1'
    if (-not (Test-Path $setupScript -PathType Leaf)) {
        throw 'The release bundle is invalid: HadexSetup.ps1 was not found.'
    }

    $powershellExe = Join-Path $PSHOME 'pwsh.exe'
    if (-not (Test-Path $powershellExe)) { $powershellExe = Join-Path $PSHOME 'powershell.exe' }
    if (-not (Test-Path $powershellExe)) { $powershellExe = 'powershell.exe' }

    Write-Host 'Launching the one-time setup. Complete each wizard window in order.' -ForegroundColor Green
    $process = Start-Process -FilePath $powershellExe -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $setupScript
    ) -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "Setup did not report success (exit code $($process.ExitCode)). The API key file, if already saved, is preserved."
    }

    Write-Host 'Setup reported success. Removing the temporary bundle...' -ForegroundColor Green
}
catch {
    Write-Error $_
    exit 1
}
finally {
    if ($TempRoot -and (Test-Path $TempRoot)) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host 'Temporary setup files removed.' -ForegroundColor Green
Write-Host 'Only the durable API key file is intentionally retained by this setup.' -ForegroundColor Gray
