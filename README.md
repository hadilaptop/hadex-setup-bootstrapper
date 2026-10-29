# Hadex one-time setup bootstrapper

This repository contains the temporary Windows setup flow only. It is **not** the future Hadex desktop application.

## Run on Windows

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/hadilaptop/hadex-setup-bootstrapper/main/bootstrap.ps1 | iex
```

The repository must be public for this unauthenticated one-command download to work.

## What the setup does

1. Downloads the latest release ZIP into a unique temporary directory and verifies its SHA-256 checksum.
2. Starts Hadex Chromium with a temporary Electron user-data directory.
3. Runs the existing Key Creator wizard to create and save an API key, unless a non-empty key file already exists.
4. Runs the Tunnels wizard and validates the captured tunnel ID.
5. Runs the Plugins wizard to add the `hadex-gpt` MCP server to ChatGPT.
6. Stops the temporary browser and removes the extracted bundle, browser/session profile, logs, caches, and temporary tunnel metadata.

The durable API key is saved to `E:\hadex\Hadex gpt2\CONTROL_PLANE_API_KEY.txt` when the E: drive exists; otherwise it uses `Documents\Hadex\CONTROL_PLANE_API_KEY.txt`. The API key is never printed or uploaded to GitHub.

The tunnel ID is used only during this one-time setup and is intentionally removed with the temporary state. The future Hadex app will need to resolve the tunnel ID from the account or its configuration; it is not part of this bootstrapper.

## Build and publish

The GitHub Actions workflow `.github/workflows/release.yml` builds a Windows ZIP containing the portable Node.js runtime, Hadex Chromium, the three existing Hadex automation flows, and a SHA-256 checksum. It publishes both assets to a GitHub Release.

Every push to `main` builds the bundle and updates the `v1.0.0` release. For versioned releases, push a tag such as `v1.1.0`, or open **Actions → Build and publish Hadex setup bundle → Run workflow** and provide a release tag.

The latest release must contain:
- `hadex-setup-win-x64.zip`
- `hadex-setup-win-x64.zip.sha256`

## Security and cleanup

- Users perform sign-in themselves; the setup never asks for their password.
- API key contents are not logged, printed, or uploaded.
- The bootstrap verifies the bundle's SHA-256 checksum before running it.
- The setup uses a dedicated temporary browser profile and does not reuse the everyday browser profile.
- If a step fails, temporary browser/session data is still removed. Any API key already saved is preserved.
- The setup does not bypass CAPTCHA or account security checks.
