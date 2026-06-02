# Auto-Invalidate SSR Cache on Deploy [Auto-Generated]

## Summary

Added mtime-based tracking of `index.html` per source directory so the SSR cache is automatically cleared when a new build is deployed. This prevents stale cached pages from being served after a deployment without requiring manual cache invalidation or a server restart.

## Changes

- Added `indexMtimeMap` to track last-seen mtime of each source directory's `index.html`
- Added `invalidateCacheIfSourceChanged()` that compares current mtime against the stored value and clears the cache if it differs
- Called the invalidation check before SSR cache lookups in both the origin-matched and fallback static-serve paths
- Bumped version to 1.0.2

## Files

| Project | Files | Change |
|---------|-------|--------|
| renderx | `src/index.ts` | Added mtime tracking and cache invalidation logic |
| renderx | `package.json` | Version bump 1.0.1 → 1.0.2 |
