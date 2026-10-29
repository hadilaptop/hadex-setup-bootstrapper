# Hadex one-time setup bootstrapper
# Usage:
#   irm https://raw.githubusercontent.com/hadilaptop/hadex-setup-bootstrapper/main/bootstrap.ps1 | iex
#
# The packaged setup bundle must be published as a ZIP asset named:
#   hadex-setup-win-x64.zip
# The bundle must contain HadexSetup.exe and the temporary Chromium/automation
# runtime. The bundle is not the future Hadex desktop application.

$ErrorActionPreference = 'Stop'
$Repo = 'hadilaptop/hadex-setup-bootstrapper'
$AssetName = 'hadex-setup-win-x64.zip'
$TempRoot = Join-Path $env:TEMP ('HadexSetup-' + [guid]::NewGuid().ToString('N'))
$ZipPath = Join-Path $TempRoot $AssetName
$ExtractPath = Join-Path $TempRoot 'package'

try {
    Write-Host ''
    Write-Host 'Hadex one-time setup' -ForegroundColor Cyan
    Write-Host 'This temporary tool creates/connects the online components.' -ForegroundColor Gray
    Write-Host 'Only the API key file should be retained after successful completion.' -ForegroundColor Gray
    Write-Host ''

    if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
        throw 'This setup bundle is for Windows PowerShell/PowerShell 7.'
    }

    New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

    $headers = @{ 'Accept' = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
    $releaseUrl = "https://api.github.com/repos/$Repo/releases/latest"
    Write-Host 'Checking for the latest published setup bundle...'
    $release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers

    $asset = @($release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1)
    if ($asset.Count -eq 0) {
        throw "No published release asset named '$AssetName' was found. The packaged setup bundle must be built and published before this command can run."
    }

    Write-Host "Downloading version $($release.tag_name)..."
    Invoke-WebRequest -Uri $asset[0].browser_download_url -OutFile $ZipPath

    if ($asset[0].size -and (Get-Item $ZipPath).Length -ne $asset[0].size) {
        throw 'The downloaded bundle size does not match GitHub release metadata.'
    }

    Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractPath -Force
    $setupExe = Join-Path $ExtractPath 'HadexSetup.exe'
    if (-not (Test-Path $setupExe -PathType Leaf)) {
        throw "The release bundle is invalid: HadexSetup.exe was not found."
    }

    Write-Host 'Launching the one-time setup. Complete the sign-in steps in the browser window.' -ForegroundColor Green
    $process = Start-Process -FilePath $setupExe -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "Setup did not report success (exit code $($process.ExitCode)). Temporary files will be removed; check the error message before retrying."
    }

    Write-Host 'Setup reported success. Cleaning temporary download and extracted files...' -ForegroundColor Green
}
catch {
    Write-Error $_
    exit 1
}
finally {
    # This removes only this run's unique temporary directory. The setup bundle
    # must save the API key to its configured durable destination before exiting.
    if ($TempRoot -and (Test-Path $TempRoot)) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host 'Temporary setup files removed.' -ForegroundColor Green
Write-Host 'The API key file is intentionally preserved for the future Hadex app.' -ForegroundColor Gray
