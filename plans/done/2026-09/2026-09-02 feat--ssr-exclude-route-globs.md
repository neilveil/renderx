# SSR Exclude Route Globs [Auto-Generated]

## Summary

Added `ssrExclude`, a list of route glob patterns that stay pure CSR even when SSR is enabled for the host. Previously SSR was an all-or-nothing switch per host, so a logged-in area like `/app` was prerendered and cached alongside public marketing pages despite having no SEO value. Excluded routes now serve `index.html` directly with no render and no cache entry.

## Changes

- Added `ssrExclude?: string[]` to both `HostConfig` and `GlobalConfig`, resolved in `getEffectiveConfig()` with the same host-overrides-global precedence as the other fields
- Generalized `matchesGlobPattern()` to match any value, so host patterns and path exclusions share one implementation
- Added `isSsrExcludedPath()`, which decodes the request path before matching so encoded routes resolve correctly
- `shouldRender()` now takes the effective config plus the request path and returns `false` for excluded routes, skipping both the render and the cache lookup
- Applied the same check in the access-log strategy label so the logged strategy matches the actual decision
- Documented the option in the setup section, the type definitions, both settings tables, and the request-flow diagram

## Behavior

`*` spans `/`, so `/app/*` also covers `/app/settings/billing`. A host-level list replaces the global one rather than merging.

```json
{
    "hosts": [
        { "source": "my-app", "host": "my-app.com", "ssrExclude": ["/app", "/app/*"] }
    ]
}
```

## Verification

Live server with `ssrExclude: ["/app", "/app/*"]`, confirmed against the access log:

| Path | Strategy | Render attempted |
|------|----------|------------------|
| `/`, `/about` | `SSR` | yes |
| `/app`, `/app/`, `/app/settings`, `/app/a/b/c` | `STATIC` | no |
| `/%61pp` | `STATIC` | no — decodes to `/app` |
| `/application` | `SSR` | yes — no accidental prefix match |

## Known Gaps

- The `/render` management endpoint still renders any path passed to it, including excluded ones. Treated as an intentional manual override rather than a bug.

## Files

| Project | Files | Change |
|---------|-------|--------|
| renderx | `src/config.ts` | Added `ssrExclude` config, generalized glob matcher, added `isSsrExcludedPath()` |
| renderx | `src/index.ts` | `shouldRender()` and access-log strategy honour the exclusion list |
| renderx | `readme.md` | Documented `ssrExclude` in setup, types, settings tables, and flow diagram |
