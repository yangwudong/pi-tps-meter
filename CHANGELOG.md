# Changelog

## [0.2.0] - 2026-11-03

- New default display `right`: one line below the editor, right-aligned so it ends in the last
  column, directly above the footer. Other extensions' footer statuses (such as pi-lens's
  `LSP Inactive`) can no longer push it around. `/tps` now cycles right → status → widget → off;
  a saved `mode` in config.json still wins.
- The thinking particle stream from opencode-tps-meter is back: while the model streams its
  reasoning, braille particles flow away from the reading, newest brightest, fading per cell.
  Configurable via `spinner` (`theme` tech / red / none, `colors`, `intervalMs`, `cells`, `enabled`).

## [0.1.1] - 2026-11-03

- Published from GitHub Actions through npm Trusted Publishing, so this and later versions
  carry a signed provenance attestation linking the package to its source commit.
- No functional changes.

## [0.1.0] - 2026-11-03

- Initial release: port of opencode-tps-meter to pi 1.5.0.
- Live TPS (5s sliding window, ~10Hz), session AVG and TTFT, colour-coded by tier.
- Calibration of the UTF-8 byte estimate against `usage.output` (median of the last 10 ratios).
- `/tps` cycles status → widget → off; `/tps status|widget|off` sets the mode. The mode is
  persisted in `~/.pi/agent/pi-tps-meter/config.json`, which also takes tier overrides.
