# Decode Percent-Encoded Request Paths [Auto-Generated]

## Summary

Fixed [issue #1](https://github.com/neilveil/renderx/issues/1): static assets whose filenames contain spaces or parentheses were served as HTML with a 200 status instead of the actual file. Express leaves `req.path` percent-encoded, so `validatePath()` was probing the filesystem with a literal `aboutUs%20%281%29-BXhYVuQk.png`, missing the file, and falling through to the SPA `index.html` handler. Request paths are now decoded through a single shared helper before any filesystem or path inspection, which also closes two traversal gaps that the previous ordering left open.

## Changes

- Added `decodeRequestPath()` in `config.ts` — one decoder with a `try/catch`, returning `null` for malformed escape sequences
- `validatePath()` decodes before resolving, so encoded filenames map to their real files on disk
- Moved the `..` traversal check to run *after* decoding, so an encoded `%2e%2e` can no longer slip past it
- Added a null-byte reject, since null bytes truncate paths in some syscalls
- Tightened the base-directory check to compare against `resolvedBase + path.sep`, so `hosts/app` no longer prefix-matches `hosts/app-other`
- `isFilePath()` decodes first so an encoded extension is still recognised as an asset request

## Verification

Live server on a demo host, with a fixture asset named `aboutUs (1)-BXhYVuQk.png`:

| Request | Before | After |
|---------|--------|-------|
| `/assets/aboutUs%20%281%29-BXhYVuQk.png` | `200 text/html` | `200 image/png`, correct bytes |
| `/assets/bad%ZZ.png` (malformed) | `200` SPA fallback | `200` SPA fallback, no crash |
| `/%2e%2e/%2e%2e/package.json` | reached the traversal check encoded | rejected, serves `index.html` |

## Files

| Project | Files | Change |
|---------|-------|--------|
| renderx | `src/config.ts` | Added shared `decodeRequestPath()` helper |
| renderx | `src/index.ts` | Decode in `validatePath()` and `isFilePath()`; reordered traversal check; null-byte reject; `path.sep` base compare |
