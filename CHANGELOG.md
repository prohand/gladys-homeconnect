# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

## [2.3.2] - 2026-10-08

- Maintenance release, no functional change.

## [2.3.1] - 2026-10-08

- Maintenance release, no functional change.

## [2.3.0] - 2026-10-08

### Changed

- The polling safety net spends far less of the Home Connect quota (1,000 requests a day): while the event stream is healthy, a poll reads the statuses only (1 request instead of 5) and re-reads the appliance in full only when they moved without an event. Every reconnection of the stream re-reads the account once. The request budget is documented.
- The refresh interval can no longer be set below 900 s (15 minutes, the default): a lower value would exhaust the daily quota on polling alone. Stored lower values are raised to 900 s.
- Requires Node.js 22 or later.

### Fixed

- When the Home Connect account cannot be read at startup (network not up yet), the real-time event stream starts anyway and the read is retried after 1, 5, then every 15 minutes, instead of waiting for the configuration to be saved again.
- An appliance is no longer read twice in parallel when Gladys' poll and the integration's own loop tick together.
- The event stream connection times out when Home Connect does not answer, instead of hanging forever; a rate limit on the stream now also pauses the REST calls.
- A refreshed token that Gladys fails to store no longer fails the request: it is kept in memory and stored again on a later request.
- An unhandled promise rejection is logged instead of stopping the integration.

## [2.2.0] - 2026-10-07

### Fixed

- The dashboard widget shows the program progress with its unit (%).
- Apply the events of the stream in the order they arrived.

## [2.1.0] - 2026-10-06

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.
- `CLAUDE.md`: guide for contributors and coding agents (commands, architecture, invariants).

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).

### Fixed

- The polling safety net behind the event stream runs again: devices are published with `should_poll: true`, without which Gladys never polls them, and an integration-owned loop polls the devices created before that flag. A missed event or reconnection window used to freeze a device until the next restart.

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

[Unreleased]: https://github.com/prohand/gladys-homeconnect/compare/v2.3.2...HEAD
[2.3.2]: https://github.com/prohand/gladys-homeconnect/compare/v2.3.1...v2.3.2
[2.3.1]: https://github.com/prohand/gladys-homeconnect/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/prohand/gladys-homeconnect/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/prohand/gladys-homeconnect/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/prohand/gladys-homeconnect/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/prohand/gladys-homeconnect/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/prohand/gladys-homeconnect/compare/v1.0.5...v2.0.0
[1.0.5]: https://github.com/prohand/gladys-homeconnect/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/prohand/gladys-homeconnect/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/prohand/gladys-homeconnect/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-homeconnect/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-homeconnect/releases/tag/v1.0.1
