# Changelog

All notable changes to `dsh-seesion-copy-enhance` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-03

First release prepared for the DSH plugin market and npm.

### Added

- `engines.dsh` (`>=0.2.0 <0.3.0`) so the market and the installer can show and
  enforce the supported DeepSeek Harness range.
- `capabilities` block in `GET /dsh-seesion-copy-enhance/health`, reporting
  whether the running Host exposes `readImage`, `readFileStream`,
  `imageHostPath` and `fileHostPath`, plus the plugin version.
- Host-side tolerance for renamed session seams: `ownEvents()` falls back to
  `snapshotEvents()` and then to a plain `session.events` list, and message
  derivation falls back to the raw event payload when `deriveEventMessage()` is
  unavailable.
- Client-side tolerance for the composer facade: text insertion uses
  `insertText(text, span)` and falls back to `setDraft(text)`; a paste is only
  intercepted when the running build can actually insert it.
- Repository files: `LICENSE` (MIT), `CHANGELOG.md`, `CONTRIBUTING.md`,
  `.gitignore`, and a GitHub Actions workflow that syntax-checks both halves and
  runs `npm pack --dry-run`.

### Changed

- `package.json` metadata rewritten for the market: fixed the corrupted em dash
  in `description`, added `keywords`, `repository`, `homepage`, `bugs`,
  `author`, and the DSH engine range.
- `README.md` / `README.zh.md` restructured around a feature summary, a
  supported-version matrix, and the install paths (market, `dsh plugin add`,
  source).

### Fixed

- Media blocks are skipped with an explicit warning instead of throwing when the
  Host attachment service lacks the reader method used by an older build.

## [0.1.3] - 2026-11-03

### Added

- `verify.ps1`: an ASCII-only PowerShell self-check that probes `/health`,
  counts media blocks through `/inspect`, captures the message with the most
  media, checks every base64 payload against its declared byte size, and
  resolves the token back.

## [0.1.2] - 2026-11-03

### Fixed

- The clipboard write starts inside the click gesture (`ClipboardItem` with a
  promise-valued `text/html`), so the HTML flavour survives the awaited Host
  capture instead of losing the browser's clipboard activation.

## [0.1.0] - 2026-11-03

### Added

- Initial plugin: host HTTP bridge (`/health`, `/inspect`, `/capture`,
  `/resolve`, same-origin guard, in-memory LRU) plus a client half that
  replaces the text-only user-message copy with a complete capture and restores
  it on paste through `createDrafts` + `addAttachments` + `insertText`.
