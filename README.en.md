# CapsuleMeterX

[简体中文](README.md) | [English](README.en.md)

CapsuleMeterX is a Windows desktop usage utility built with React, TypeScript, Rust, and Tauri 2. It provides a compact, draggable desktop capsule and a system-tray usage ring with a full details panel.

## Features

- **Floating capsule:** 32px tall with content-adaptive width (64–280px). Drag it to snap to a monitor work-area edge; its position is restored on the next launch.
- **Usage metrics:** Shows remaining five-hour and weekly usage. The left and right halves of the capsule border reflect the consumption pace for those windows, respectively; they do not represent remaining quota.
- **Fast mode:** A lightning icon reports whether fast mode is enabled when Codex App Server exposes that configuration.
- **Tray usage ring:** A 32×32 transparent icon with an empty center. Its ring represents five-hour remaining usage only; unknown or offline usage is shown in gray.
- **Hover details:** Hover over the tray icon or capsule to open the full panel with five-hour and weekly reset times, reset-card count, and expiry details.
- **Reset-card flow:** A confirmation is required before use. The app reports success and refreshes usage only after the server confirms the operation. Cards with missing data or identifiers cannot be used.
- **Tray menu:** Manually refresh usage or quit the app.

The tray ring color follows the five-hour remaining percentage:

| Remaining | Color | Status |
| --- | --- | --- |
| ≥ 60% | `#19E6B5` | Healthy |
| 30–59% | `#FFD449` | Warning |
| 10–29% | `#FF923F` | Low |
| < 10% | `#FF4D68` | Critical |

## Data source

The app starts Codex App Server through the local Codex CLI and reads usage, plan, and reset-card data available to the signed-in account. It does not simulate or estimate quota. Reset-card use depends on the actual card identifier and operation result returned by App Server; an unconfirmed result is never reported as success.

CapsuleMeterX checks a common Codex CLI installation path first and falls back to `codex` on `PATH`. If the executable is elsewhere, set this environment variable before launching the app:

```powershell
$env:CODEX_CLI_PATH = "C:\path\to\codex.exe"
```

Make sure that this Codex CLI can access the account whose usage you want to view.

## Development prerequisites

- Windows
- Node.js and pnpm
- Stable Rust with the MSVC toolchain and the Windows C++ build tools
- Microsoft Edge WebView2 Runtime
- Codex CLI installed and configured for your account

From the repository root, run:

```powershell
pnpm install
pnpm tauri:dev
```

## Build

```powershell
# Type-check TypeScript and build the frontend assets
pnpm build

# Build the Tauri desktop application
pnpm tauri build
```

## Project structure

- `src/`: React and TypeScript frontend, capsule, and details panel
- `src-tauri/src/lib.rs`: Tauri windows, system tray, usage reads, and reset-card operations
- `src-tauri/tauri.conf.json`: desktop window and build configuration
