# Changelog

All notable changes to the **Automation Jira Agent** extension will be documented in this file.

## [1.0.3] - 2026-07-14
### Added
- Added support for specifying a custom base branch (`baseBranch`) in workflow configurations.
- Added a configuration toggle (`createPR`) to enable or disable automatic GitHub pull request creation.

## [1.0.2] - 2026-07-11
### Added
- Added official extension `CHANGELOG.md` to the package manifest for marketplace visibility.

## [1.0.1] - 2026-07-11
### Changed
- Renamed display name to `Automation Jira Agent` to resolve duplicate marketplace listing conflicts.
- Added and linked a clean 128x128 PNG extension icon for the marketplace.

## [1.0.0] - 2026-07-10
### Added
- Initial public release.
- Added cross-platform support for Windows, Linux, and macOS (running headlessly via user `crontab` and `pwsh`).
- Implemented automatic background scheduler/cron job disabling when all workflows are stopped or deleted.
- Added detailed documentation of all core and advanced configuration properties.
