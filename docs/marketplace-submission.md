# Listing this plugin in the DSH market

The market that ships with DSH (`dshmarket`, "Plugins → Discover") does not take a
central submission form. It reads the curated list
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin),
whose CI publishes `plugins.json` / `index.json` from that README. A plugin appears
in the market once a pull request adding one line is merged — usually within a day.

## 1. Make the package installable

- [x] `package.json` declares `dsh.bundle.patch` and `dsh.client` (a Cordis bundle).
- [x] `engines.dsh` states the supported Harness range (`>=0.2.0 <0.3.0`).
- [x] The package is published on npm under the exact name `dsh-seesion-copy-enhance`.
- [x] The repository is public, has a README, a LICENSE and a CHANGELOG.
- [x] `dsh plugin --profile desktop add dsh-seesion-copy-enhance` works from a clean profile.

## 2. The pull request

Fork `awesome-dsh-plugin/awesome-dsh-plugin`, then add one line under
**Sessions & Messages** (keep the alphabetical order the file uses):

```markdown
- [JMILI/dsh-seesion-copy-enhance](https://github.com/JMILI/dsh-seesion-copy-enhance) - Copy a whole DSH chat message (text, images, videos and files) and paste it back into any session with the attachments rebuilt as real drafts.
```

Replace `OWNER` with the GitHub account that holds the repository.

Suggested PR title:

```
Add dsh-seesion-copy-enhance (Sessions & Messages)
```

Suggested PR body:

```markdown
## What it is

`dsh-seesion-copy-enhance` replaces DSH's text-only copy button on user messages
with a complete capture: text plus every image and file attachment.

- **Copy**: a capture-phase click handler on the shipped copy button asks a
  same-origin Host route (`/dsh-seesion-copy-enhance/capture`) for the message
  body read from `ctx.sessions` and `ctx.attachments`, then writes
  `text/plain` + `text/html` (inline `data:` images and a hidden token) in a
  single `ClipboardItem`, started inside the click gesture.
- **Paste**: the token resolves back to the bundle, `createDrafts()` rebuilds
  real `File` objects, and `addAttachments()` / `insertText()` place them in the
  composer. Nothing is faked; the drafts upload and send through the normal path.
- **Security**: every route is same-origin checked, `/inspect` returns shapes
  only, captured bundles live in Host memory (LRU 32) and never touch disk.

## Install

```sh
dsh plugin --profile desktop add dsh-seesion-copy-enhance
```

npm: https://www.npmjs.com/package/dsh-seesion-copy-enhance
Source: https://github.com/JMILI/dsh-seesion-copy-enhance

## Compatibility

`engines.dsh: >=0.2.0 <0.3.0`. Verified end-to-end on `0.2.1-rc.5`; on a Host
without the attachment reader the plugin degrades to a text-only copy instead of
throwing, and `/health` reports `capabilities` so the mismatch is diagnosable.

## Verification

`verify.ps1` in the repository re-runs the Host chain against a live instance
(health, inspect, capture with byte-exact base64 checks, resolve round-trip).
Latest run: 8 attachments, 5449715 bytes, byte-exact, no warnings.
```

## 3. After the merge

The market picks up the change on the next index build. Nothing in this plugin
needs to change for that step; the listing is derived from `package.json` and the
GitHub README.
