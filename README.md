# Hadex Setup Bootstrapper

This repository is for the **one-time setup flow only**. It is not the future Hadex desktop application.

## Intended user command

Run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/hadilaptop/hadex-setup-bootstrapper/main/bootstrap.ps1 | iex
```

The script downloads the latest release asset into a unique temporary directory, launches the setup bundle, waits for its exit code, and removes that temporary directory. It does not clone the repository or leave a source checkout on the computer.

## Required release artifact

The latest GitHub Release must contain:

- `hadex-setup-win-x64.zip`
- The ZIP must contain `HadexSetup.exe` at its root.
- The executable must run the one-time browser/login/key/tunnel/plugin workflow and return exit code 0 only after successful completion.
- The API key must be saved to the agreed durable path for the future Hadex application **before** the setup exits.
- Browser profile, authentication session data, logs, downloaded dependencies, and other temporary artifacts must be placed under the run's temporary directory or another explicitly temporary directory and cleaned after success.
- The setup must never delete the retained API key when cleaning temporary data.

## Current status

The bootstrap script is committed as the delivery entry point. The packaged setup executable is a separate build artifact and must be produced from the existing Hadex Chromium and Key Creator automation before the command can complete a real setup. Until the release asset exists, the script stops with a clear message instead of pretending the workflow ran.

## Security notes

- Users sign in themselves in the browser; this tool must not ask for or log their passwords.
- API keys are secrets. Do not print the full key in logs, upload it to GitHub, or include it in diagnostic bundles.
- This bootstrapper currently expects a GitHub Release asset. It verifies the downloaded file size against GitHub release metadata; production releases should additionally publish a SHA-256 checksum and/or signed executable.
- The temporary setup bundle should only create the requested resources and should not bypass account security checks or CAPTCHAs.
