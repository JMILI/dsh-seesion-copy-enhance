# dsh-seesion-copy-enhance

Copy a **whole** chat message in DeepSeek Harness - text, images, videos and files - and paste it back into **any** session with the attachments still there.

DSH's built-in copy button writes `text` only, so a message with screenshots or files arrives elsewhere as bare text. This plugin takes over that button, puts the complete message on the clipboard, and rebuilds the attachments as real composer drafts when you paste - ready to send.

- Package: `dsh-seesion-copy-enhance` (spelling follows the original request, `seesion`; use it verbatim when installing)
- Version: `0.2.0`
- License: MIT, source on [GitHub](https://github.com/JMILI/dsh-seesion-copy-enhance)

## What it does

| Action | Stock DSH | With this plugin |
| --- | --- | --- |
| Copy a message with images | text only | text + every image |
| Copy a message with files/videos | text only | text + every attachment |
| Paste into another session | plain text | text + attachment cards, ready to send |
| Paste into the same session | plain text | text + attachment cards |
| Paste into a rich-text app (Word, Notion, mail) | plain text | text + inline images |
| Paste after a page reload | plain text | text + attachments (restored through the Host bridge) |

The clipboard carries two flavours: `text/plain` (clean text - pasting into a terminal still works)
and `text/html` (a hidden media token plus inline `data:` images). On paste the client reads the
token, asks the Host for the full bundle, turns every entry back into a real `File`, and hands it to
the session's draft-attachment channel - the same path drag-and-drop uploads use. The attachments are
genuine drafts: they upload and send normally. Nothing is a fake card.

## Supported versions

| DSH version | Status | Notes |
| --- | --- | --- |
| `0.2.1-rc.5` | ✅ Verified | End-to-end on this machine: capture / resolve / clipboard write / draft restore |
| `>=0.2.0 <0.3.0` | ✅ Declared | `engines.dsh` in `package.json`; the market and the installer check it |
| other `0.2.x` rc builds | ⚠️ Expected | Uses public 0.2 slots and services, not verified per rc |
| `0.1.x` | ❌ Unsupported | No `conversation.composer.dock` slot and no `createDrafts` draft channel |
| `>=0.3.0` | ❌ Not declared | Re-verify before widening the range |

The plugin also self-checks at runtime: `GET /dsh-seesion-copy-enhance/health` reports `version` and
`capabilities` (whether `readImage` / `readFileStream` / `imageHostPath` / `fileHostPath` exist). If a
capability is missing, the plugin does **not** throw - it degrades to a text-only copy, says so in the
toast, and leaves the stock copy/paste behaviour untouched.

## Install

### 1. Plugin market (recommended)

Open **Plugins → Discover** in DSH, search for `dsh-seesion-copy-enhance`, install, then restart or
refresh as prompted.

### 2. Command line

```powershell
dsh plugin --profile desktop add dsh-seesion-copy-enhance
```

Use your real profile name (`desktop` on the desktop app, often `web` on a web install).

### 3. In-app plugin manager (local package)

Pack first, then install the `.tgz`:

```powershell
pnpm pack --pack-destination C:\Users\<you>\.dsh\staging
# then, in Plugins → install bundle, pick:
#   file:C:/Users/<you>/.dsh/staging/dsh-seesion-copy-enhance-0.2.0.tgz
```

Installing from a `file:` **directory** only works on ordinary Windows paths. A package living on a
UNC path such as `\\wsl.localhost\...` fails with `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND` because pnpm
rewrites the leading `\\`. Packing to `.tgz` makes pnpm copy real files into the profile, which is the
most reliable route.

### 4. From source

```powershell
git clone https://github.com/JMILI/dsh-seesion-copy-enhance.git
dsh plugin --profile desktop add .\dsh-seesion-copy-enhance
```

Editing `lib/index.js` (Host half) needs a reinstall or an app restart; `lib/client.js` (client half)
reloads with the page.

## How it works

```
copy   ──►  client: POST /dsh-seesion-copy-enhance/capture { sessionId, seq, text }
            Host:   reads the live session log (ctx.sessions) and the attachment
                    store (ctx.attachments); returns text + base64 media
            client: writes { text/plain, text/html } to the clipboard
paste  ──►  client: sees the media token in text/html
            Host:   POST /resolve returns the bundle (when this page forgot it)
            client: createDrafts() → addAttachments() → insertText()
```

* **Host half** (`lib/index.js`) registers four same-origin routes on `ctx.webServer`:
  `GET /health`, `GET /inspect`, `POST /capture`, `POST /resolve`. Everything comes from existing
  services; nothing is written to disk and no schema changes. A request carrying a foreign `Origin`
  gets `403 cross-origin` before it can read a session.
* **Client half** (`lib/client.js`) mounts an invisible component on `conversation.composer.dock` to
  receive the current `sessionId` and the composer's `inputActions`, then listens for copy and paste in
  the document capture phase.
* Media never leaves memory as a URL: the clipboard itself carries the bytes, so pasting works across
  sessions, across windows, and after a reload.

## Requirements

* DSH Web UI 0.2.x (the desktop app uses the same UI and works identically).
* A secure context for the clipboard APIs: `http://127.0.0.1` and `http://localhost` both qualify.

## Configuration

All optional, set on the plugin entry in `cordis.patch.yml`:

```yaml
- insert:
    - id: seesion-copy-enhance
      name: 'dsh-seesion-copy-enhance'
      config:
        maxAttachmentBytes: 25165824   # skip a single attachment above this size
        maxBundleBytes: 25165824       # ceiling for the whole message
        history: 32                    # how many captured messages stay resolvable in memory
```

Attachments that are skipped appear in the response's `warnings` and in the browser console; the rest
of the message is still copied.

## Verified on this machine (2026-11-03, DSH `0.2.1-rc.5`)

| Check | Result |
| --- | --- |
| `GET /health` | `200 {"ok":true,"version":"0.2.0",...}` |
| `GET /inspect` | 200, shapes for 2 sessions and 10 / 267 user messages |
| `POST /capture` on a real 8-screenshot message | 8 PNGs, bytes 1354080 / 2025508 / 1203138 / 216053 / 38122 / 319601 / 52797 / 240416, **each matching its declared `bytes`**, `warnings: []` |
| Text of that payload | 859 characters, identical to the message body |
| `POST /resolve` (by token) | text and all 8 attachments byte-identical |
| `POST /resolve` (text fallback) | same text, 8 attachments |
| Cross-site request (forged `Origin`) | `403 {"ok":false,"error":"cross-origin"}` |
| Client registration | `conversation.composer.dock` occupant `dsh-seesion-copy-enhance`, order 60, `active: true` |

Re-run the checks with `powershell -File verify.ps1` (`pwsh -File verify.ps1` on PowerShell 7; add
`-Capture` for the media round-trip). The script is plain ASCII, so Windows PowerShell 5.1 runs it
directly.

### Manual acceptance (30 seconds)

1. Find a user message **with images** in any session and click its copy button → the toast reads
   `已复制文字 + N 个附件，可粘贴到任意会话`.
2. Open the composer of another session (or the same one) and press `Ctrl+V` → the original text plus
   N attachment cards appear.
3. Press `Enter` → the new message shows the images again.

## Privacy and security

* Bridge routes accept same-origin requests only. `/inspect` returns shapes only (session id, message
  seq, text length, block types) and never lifts message text out of a session.
* Captured bundles stay in Host memory (the most recent 32 by default) and vanish when the plugin
  unloads or the Host restarts. Nothing is written to disk.
* The clipboard is written only when you click copy; the plugin never reads it and never uploads it
  anywhere.

## Known limits

* It copies the attachments the message really holds; media already garbage-collected by the Host
  cannot be restored.
* 24 MB per attachment and per message by default, to keep the clipboard write responsive. Raise it if
  you routinely move large videos.
* It copies the message source text, not the rendered markdown.
* Videos and audio travel as ordinary file cards; they are not previewed inline in the composer (DSH
  itself does not preview them there either).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Toast says "已复制文字（这条消息没有附件）" | The message genuinely has no attachments | Expected |
| Toast says "已复制文字（未取到附件）" | The capture request failed or the Host cannot read attachments | Check the console for `[dsh-seesion-copy-enhance]` and `/health` `capabilities` |
| Toast says "无法写入剪贴板" | The browser denied the clipboard | Click the page once and check the clipboard permission |
| Paste arrives as text only | An intermediate app dropped the token | Copy again from DSH; DSH→DSH and DSH→rich text both keep it |
| No attachment cards | The composer was locked (adjudicating/submitting) | Wait until the send button is idle and paste again |
| Routes return 404 | The Host half did not load (edited without reinstalling) | Reinstall the `.tgz` or restart the app |

Probe the Host routes directly while debugging:

```powershell
curl http://127.0.0.1:<GUI-port>/dsh-seesion-copy-enhance/health
curl http://127.0.0.1:<GUI-port>/dsh-seesion-copy-enhance/inspect
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). There is no build step: `lib/client.js` is exactly the file the
browser loads, so a page refresh picks up client changes; `lib/index.js` needs a reinstall.

## License

MIT, see [LICENSE](LICENSE).
