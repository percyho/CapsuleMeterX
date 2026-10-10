# Changelog

## [0.3.2] - 2026-10-09

### Changed

- Moved the fast-mode lightning indicator between the five-hour and weekly capsule values.
- Added hover hints to the statistics page icons and controls.
- Parsed the nested daily Token totals returned by the usage endpoint and displayed its input/output totals.

## [0.3.1] - 2026-10-09

### Changed

- Fetch daily Token history directly from the authenticated usage endpoint, so Token statistics no longer depend on starting Codex App Server.

## [0.3.0] - 2026-10-09

### Added

- Set the NSIS installer and uninstaller icons to the CapsuleMeterX Logo (`src-tauri/icons/icon.ico`).

### Changed

- Read five-hour and weekly quota data from the local Codex authentication file and ChatGPT usage endpoint; keep App Server for Token statistics, fast mode, and reset-card operations.

## [0.2.1] - 2026-10-09

### Changed

- Moved the fast-mode indicator between the five-hour and weekly usage values, and matched usage-ring percentages to the ring status color.
- Clarified quota-history controls and refined CSV export button styling.
- Set the Windows NSIS installer and uninstaller icons to the CapsuleMeterX logo.

## [0.2.0] - 2026-10-08

### Added

- Added mouse-wheel zoom to quota and Token history charts.
- Added theme synchronization to the statistics window and coordinated circular theme transitions.
- Added restrained icon feedback for fast-mode activation, usage updates, reset-card hover, and reset outcomes.
- Added static refresh and exit icons to the native system-tray menu.
- Redesigned the usage details panel with remaining-usage rings, localized reset times, and a compact dark layout.
- Added reset-card expiry details, expiry urgency colors, and a confirmation flow before card use.
- Added reset-card consumption through the Codex App Server, with per-card request protection and usage refresh after confirmed success.

### Changed

- Replaced the tray percentage glyph with a transparent-center, five-hour usage ring using four remaining-usage alert colors.
- Opened the full interactive usage panel on tray hover and aligned its DPI-aware bounds to the tray monitor.
- Avoided resetting the native tray icon when its five-hour remaining percentage has not changed.
- Preserved the measured usage-panel height when opening from the tray to prevent clipped details.
- Doubled the usage ring stroke width and matched reset-card icons to the reference ticket outline.
- Kept all icon animations CSS-based and honored the system reduced-motion preference without adding dependencies.
- Adjusted the details tooltip width to fit the redesigned panel without a scrollbar.
- Kept the details panel open while the pointer moves from the capsule and enabled interaction with reset-card controls.
