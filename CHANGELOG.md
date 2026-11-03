# Changelog

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
