# Contributing to dsh-seesion-copy-enhance

Thanks for taking the time to help. This plugin is small on purpose: one Host
file, one browser file, no build step.

## Layout

```
lib/index.js        Host half  - HTTP bridge, session read, attachment read
lib/client.js       Client half - clipboard interception (served as-is, ESM)
cordis.patch.yml    Bundle patch: inserts the loader entry
locale/{en,zh}.json meta.title / meta.description shown in the plugin manager
verify.ps1          Self-check against a running Host (ASCII only, PS 5.1 safe)
```

`lib/client.js` is already the exact file the browser loads: it is wrapped in a
`window.__ModuleLoader__.load({ id, factory(require) { ... } })` call and needs
no bundler. Keep it that way; do not add bare imports.

## Ground rules

- **No new dependencies.** Both halves must run on the Node and Chromium that
  DSH already ships.
- **No `import` of `@deepseek-ai/*` packages** from either half. The client half
  receives them through the `require` argument of the module factory; the Host
  half gets services through `ctx`.
- **Degrade, never break.** If a Host seam is missing, the plugin must fall back
  to the shipped behaviour (text-only copy) and explain itself in a toast or a
  `warnings` entry. A missing capability is not an exception.
- **Never widen the bridge trust boundary.** Every route stays same-origin
  checked, and `/inspect` keeps returning shapes only - never message text.

## Local loop

```powershell
# 1. syntax check both halves (Node 20+ is enough)
node --check lib/index.js
node --check lib/client.js

# 2. pack and install into your profile
pnpm pack --pack-destination $env:TEMP\dsh-pack
# then, in DSH: plugin_manager install_bundle with
#   file:<absolute path to the .tgz>

# 3. self-check the running Host
powershell -File verify.ps1      # add -Capture to also round-trip media
```

The Host half is not hot-reloaded: after editing `lib/index.js`, reinstall the
tarball (or restart the app) before trusting `/health`. The client half reloads
with the page.

## Testing a change

1. `verify.ps1` must pass (`health`, `inspect`, `capture`, `resolve`).
2. Copy a message that carries images **and** a file; the toast must report the
   attachment count.
3. Paste into a different session: the text returns and the attachments appear
   as composer cards; sending must succeed.
4. Paste into a plain text box outside DSH: at minimum the text must arrive.

## Commit messages

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`). Keep the subject
under 72 characters and describe behaviour, not files.

## License

By contributing you agree that your work is released under the MIT license in
`LICENSE`.
