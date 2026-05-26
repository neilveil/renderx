# Documentation Update Plan

## Overview

Rewrite all project documentation to reflect the v2 simplification (no bot detection, no `smart-ssr`, no `maxConcurrency`) and new features (stale-while-revalidate cache, context pooling, render queue, structured JSON logs). Documentation must match the new codebase exactly.

## Impact Assessment

- **Scope**: Medium
- **Risk**: Low
- **Affected Areas**: `readme.md`, `contributing.md`, `config.ts` (root type defs)

**Assessment**: Pure documentation changes. No code impact. Must be done AFTER all implementation is complete so docs reflect final behavior.

## Task Breakdown

### Phase 1: Update `readme.md`

#### 1.1: Update hero section

- [ ] Rewrite tagline — remove "for search engines and bots" framing, replace with universal rendering:
    > RenderX renders your SPA pages on-the-fly and caches the result. Every visitor gets fully rendered HTML, instantly.
- [ ] Update "What It Does" bullets:
    - Remove "Detecting bots automatically"
    - Add "Queues renders with priority"
    - Add "Refreshes cache in background (stale-while-revalidate)"
    - Keep "Rendering pages using a headless browser"
    - Keep "Caching results for speed"
    - Reword "Serving static files to regular users" → "Serves static assets directly"

#### 1.2: Update type definitions

- [ ] Change `RenderingStrategy` to `'ssr' | 'csr'`
- [ ] Remove `bots?: string[]` from both `HostConfig` and `GlobalConfig`
- [ ] Remove `maxConcurrency?: number` from `GlobalConfig`
- [ ] Add `logFormat?: 'text' | 'json'` to `GlobalConfig`
- [ ] Update `strategy` default from `'smart-ssr'` to `'ssr'`

#### 1.3: Update config tables

- [ ] **Global Settings table**:
    - Remove `bots` row entirely
    - Change `strategy` default to `"ssr"`, remove `smart-ssr` from description
    - Remove `maxConcurrency` (if still listed)
    - Add `logFormat` row: `'text' | 'json'`, default `'json'`
    - Update `logs` description: `"ssr"` logs SSR/SSR-CACHE/SSR-REFRESH, `"all"` includes STATIC
- [ ] **Host Settings table**:
    - Remove `bots` row
    - Change `strategy` default to `"ssr"`, remove `smart-ssr` from description

#### 1.4: Update "How It Works" section

- [ ] Remove "Bot Detection" step
- [ ] Rewrite flow:
    1. Request arrives with Origin header
    2. Match host config
    3. If strategy is `csr` → serve static file
    4. If strategy is `ssr` → check cache → serve or render
- [ ] Update mermaid diagram:
    ```mermaid
    flowchart TD
        A[Request Arrives] --> B{Check Strategy}
        B -->|csr| C[Serve Static File]
        B -->|ssr| D{Check Cache}
        D -->|Fresh Hit| E[Serve Cached HTML]
        D -->|Stale Hit| F[Serve Cached HTML]
        F --> G[Background Re-render]
        D -->|Miss| H[Render with Headless Browser]
        H --> I[Cache Result]
        I --> J[Serve Rendered HTML]
    ```

#### 1.5: Update "Rendering Strategies" section

- [ ] Remove `smart-ssr` entirely
- [ ] Rewrite:
    - **`ssr`** (default): Renders pages and caches the result. Stale cache is served instantly while refreshing in background.
    - **`csr`**: Never renders. Serves static files only. Use for apps that don't need pre-rendering.

#### 1.6: Update "Testing" section

- [ ] Remove bot UA test (`-H "User-Agent: Googlebot"`)
- [ ] Replace with:
    ```bash
    # First request (renders page):
    curl http://localhost:8080 -H "Origin: https://my-app.com"

    # Second request (served from cache, instant):
    curl http://localhost:8080 -H "Origin: https://my-app.com"
    ```

#### 1.7: Add new sections

- [ ] **Caching** section:
    - Explain stale-while-revalidate behavior
    - `cacheCleanupInterval` determines freshness threshold (stale after half, cleaned after 2x)
    - Mention cache invalidation via container restart or file deletion
- [ ] **Logging** section:
    - Log labels: `SSR`, `SSR-CACHE`, `SSR-REFRESH`, `STATIC`
    - Log format: `text` (human-readable) or `json` (structured for log aggregators)
    - Log levels: `none`, `ssr`, `all`
- [ ] **Render Queue** section (brief):
    - Requests are queued when at capacity (not rejected)
    - Background refreshes have lower priority than incoming requests

#### 1.8: Clean up

- [ ] Remove any remaining references to "bot", "bot detection", "smart-ssr", "maxConcurrency"
- [ ] Verify all config examples use new schema

### Phase 2: Update `contributing.md`

#### 2.1: Update architecture section

- [ ] Remove "Checks if bot (user agent detection)" from request flow
- [ ] Remove `smart-ssr` from strategy list
- [ ] Update flow to:
    ```
    1. Request arrives with Origin header
    2. Parse hostname from Origin
    3. Find matching host config
    4. Determine rendering strategy:
       - ssr: Check cache → render if miss
       - csr: Serve static files
    5. If rendering:
       - Check cache (fresh/stale/miss)
       - If fresh hit: return cached HTML
       - If stale hit: return cached HTML + background refresh
       - If miss: render with Playwright, cache, return
    6. If not rendering:
       - Serve static files directly
    ```

#### 2.2: Update core components description

- [ ] **Cache** — mention stale-while-revalidate, 2x TTL cleanup
- [ ] **Renderer** — mention context pooling, render queue
- [ ] Add **Context Pool** (`src/contextPool.ts`) — pre-warmed browser contexts for lower latency
- [ ] Add **Render Queue** (`src/renderQueue.ts`) — priority queue, prevents rejection at capacity

#### 2.3: Update project structure

- [ ] Add new files:
    ```
    src/
    ├── index.ts          # Express server & routing
    ├── config.ts         # Configuration loader
    ├── renderer.ts       # Playwright renderer
    ├── contextPool.ts    # Browser context pool
    ├── renderQueue.ts    # Priority render queue
    ├── cache.ts          # File-based cache (stale-while-revalidate)
    ├── logger.ts         # Logging utility (text/JSON)
    └── htmlOptimizer.ts  # HTML SEO optimizer
    ```

#### 2.4: Update health endpoint example

- [ ] New response:
    ```json
    {
      "status": "ok",
      "activeRenders": 0,
      "parallelRenders": 10,
      "queueDepth": 0,
      "hosts": 1
    }
    ```

#### 2.5: Update verification section

- [ ] Remove "Test Bot Rendering" section
- [ ] Replace with:
    - Test SSR (any request to a page route)
    - Test cache (second request should be fast)
    - Test static (request to a file path)
- [ ] Update logs section — document new labels and JSON format

#### 2.6: Update caching section

- [ ] Change "Key: MD5 hash" to "Key: SHA-256 hash" (already changed in code)
- [ ] Add stale-while-revalidate explanation
- [ ] Add cleanup behavior (2x TTL)

#### 2.7: Clean up

- [ ] Remove all "bot" references
- [ ] Remove "smart-ssr" references
- [ ] Remove "maxConcurrency" references

### Phase 3: Update root `config.ts`

- [ ] Remove `bots?: string[]` from `HostConfig`
- [ ] Remove `bots?: string[]` from `GlobalConfig`
- [ ] Remove `maxConcurrency?: number` from `GlobalConfig`
- [ ] Change `RenderingStrategy` to `'ssr' | 'csr'`
- [ ] Add `logFormat?: 'text' | 'json'` to `GlobalConfig`

### Phase 4: Update `makefile`

- [ ] Remove `test-csr` and `test-ssr` (bot-based) targets
- [ ] Add new targets:
    ```makefile
    test-ssr:
    	@echo "Testing SSR..."
    	@curl -s http://localhost:8080 -H "Origin: https://demo-app.com" | grep -q "<title>" && echo "PASS" || echo "FAIL"

    test-cache:
    	@echo "Testing cache..."
    	@curl -s http://localhost:8080 -H "Origin: https://demo-app.com" > /dev/null
    	@curl -s -o /dev/null -w "Cache response: %{time_total}s\n" http://localhost:8080 -H "Origin: https://demo-app.com"

    test-static:
    	@echo "Testing static..."
    	@curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/vite.svg -H "Origin: https://demo-app.com"

    test-health:
    	@curl -s http://localhost:8080/health | python3 -m json.tool

    test-all: test-ssr test-cache test-static test-health
    ```

## Checklist

After all docs are updated, verify:

- [ ] No remaining references to: `bot`, `bots`, `smart-ssr`, `maxConcurrency`, `CSR` (as log label), `botOnly`
- [ ] All config examples use new schema
- [ ] All curl examples work against the new server
- [ ] Mermaid diagrams match actual code flow
- [ ] Type definitions in readme match `src/config.ts` exactly
