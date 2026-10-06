# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.
- `CLAUDE.md`: guide for contributors and coding agents (commands, architecture, invariants).

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).

## [2.0.1] - 2026-09-22

### Fixed

- Recover on their own when the account was never read

## [2.0.0] - 2026-09-22

### Added

- Dashboard widgets, scene triggers and scene actions (Gladys 5.1)

## [1.0.5] - 2026-08-15

### Changed

- Update for Gladys 4.86: SDK 0.12.0 and store catalog categories

## [1.0.4] - 2026-08-13

### Fixed

- Keep unchanging values from expiring on the dashboard

## [1.0.3] - 2026-08-08

### Fixed

- Pin cover_image to the release tag so a new cover is picked up

## [1.0.2] - 2026-08-08

### Added

- Add new cover image for the Home Connect integration

## [1.0.1] - 2026-08-07

First public release.

### Added

- Home Connect integration for Gladys Assistant

### Fixed

- Acknowledge the OAuth callback before reading the account
- Publish devices with a poll frequency Gladys accepts
- Fill in device values on the first connection
- Fix door polarity, nameless features, empty alerts; default to French

[Unreleased]: https://github.com/prohand/gladys-homeconnect/compare/v2.0.1...HEAD
[2.0.1]: https://github.com/prohand/gladys-homeconnect/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/prohand/gladys-homeconnect/compare/v1.0.5...v2.0.0
[1.0.5]: https://github.com/prohand/gladys-homeconnect/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/prohand/gladys-homeconnect/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/prohand/gladys-homeconnect/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-homeconnect/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-homeconnect/releases/tag/v1.0.1
