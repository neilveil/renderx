# RenderX v2 Performance & Reliability Plan

## Overview

Three improvements to RenderX performance and reliability: browser context pooling to reduce render latency, a render queue with priority to prevent stale-refreshes from blocking real requests, and structured JSON logs for log aggregator compatibility.

## Impact Assessment

- **Scope**: Medium
- **Risk**: Medium
- **Affected Areas**: `src/renderer.ts`, `src/index.ts`, `src/logger.ts`

**Assessment**: Context pooling changes the core render path — needs careful resource management to avoid leaks. Render queue replaces the simple counter-based concurrency limit with a proper queue — more complex but strictly better behavior. JSON logs are a breaking change for anyone parsing the current text format.

## Task Breakdown

### Phase 1: Browser Context Pooling

> Reduces per-render latency by ~100-200ms by reusing pre-warmed browser contexts instead of creating/destroying per request.

#### 1.1: Create context pool

- [ ] Create `src/contextPool.ts` module
- [ ] Define pool config: `poolSize` (default: `parallelRenders`), `maxIdleTimeMs` (how long an idle context lives before being closed)
- [ ] Implement pool as an array of `{ context: BrowserContext, inUse: boolean, createdAt: number }`
- [ ] On pool init: pre-create `poolSize` contexts from the shared browser instance
- [ ] Expose `acquire(): Promise<BrowserContext>` — returns an idle context, marks it as in-use
- [ ] Expose `release(context): void` — marks context as idle, resets page state for reuse
- [ ] Expose `destroy(): Promise<void>` — closes all contexts (for graceful shutdown)

#### 1.2: Page reset on release

- [ ] After a render completes, instead of closing the context, reset it for reuse:
    - Navigate to `about:blank`
    - Clear cookies/storage if needed
- [ ] If reset fails (context crashed), discard and create a fresh one in the pool

#### 1.3: Integrate with renderer

- [ ] Replace `context = await browserInstance.newContext(...)` with `context = await pool.acquire()`
- [ ] Replace context/page close in `finally` block with `pool.release(context)`
- [ ] Keep the timeout-based cleanup as a safety net — if release hangs, force-close and replace in pool
- [ ] Pre-configure contexts in pool with the same settings (viewport, permissions, userAgent) — userAgent and origin headers are set per-request via route interception, so context can be shared

#### 1.4: Pool lifecycle

- [ ] Initialize pool in `preLaunchBrowser()` (server startup)
- [ ] Destroy pool on `SIGTERM`/`SIGINT`
- [ ] If browser disconnects, reset pool (re-create all contexts after browser relaunch)
- [ ] Periodically recycle old contexts (e.g., after 50 renders or 10 minutes) to prevent memory leaks

### Phase 2: Render Queue with Priority

> Instead of rejecting at capacity, queue requests. Background stale-refreshes get lower priority than incoming real requests.

#### 2.1: Define queue structure

- [ ] Create `src/renderQueue.ts` module
- [ ] Define priority levels: `high` (real incoming request), `low` (background stale-refresh)
- [ ] Queue item: `{ url, config, origin, priority, resolve, reject, enqueuedAt }`
- [ ] Max queue size config (prevent unbounded growth) — default: `parallelRenders * 3`

#### 2.2: Implement queue processing

- [ ] Maintain `activeCount` (currently rendering) and `queue` (waiting)
- [ ] `enqueue(item)`: if `activeCount < parallelRenders`, execute immediately. Otherwise, add to queue sorted by priority (high first, then FIFO within same priority)
- [ ] On render complete: `activeCount--`, dequeue next item, execute it
- [ ] Queue timeout: if an item waits longer than `timeoutMs`, reject with timeout error

#### 2.3: Integrate with existing code

- [ ] Replace the hard reject in renderer (`if (currentRequests >= config.maxConcurrency) throw`) with `enqueue()` call
- [ ] `renderPage()` in `src/index.ts`: enqueue with `priority: 'high'`
- [ ] `triggerBackgroundRefresh()` (from Phase 3 of v2 plan): enqueue with `priority: 'low'`
- [ ] `/render` endpoint: enqueue with `priority: 'high'`

#### 2.4: Observability

- [ ] Add queue depth to `/health` endpoint response: `{ queueDepth, activeRenders, parallelRenders }`
- [ ] Log warning when queue is >80% full
- [ ] Log when items are dropped due to queue overflow

### Phase 3: Structured JSON Logs

> Replace text log format with JSON for log aggregator compatibility (Datadog, ELK, CloudWatch).

#### 3.1: Define log schema

- [ ] Request log fields:
    ```json
    {
      "ts": "2026-05-19T12:00:00.000Z",
      "method": "GET",
      "host": "my-app.com",
      "path": "/about",
      "status": 200,
      "strategy": "SSR",
      "duration": 1200,
      "cache": "HIT|MISS|REFRESH",
      "queue_wait": 50
    }
    ```
- [ ] System log fields:
    ```json
    {
      "ts": "...",
      "level": "info|warn|error",
      "msg": "...",
      "context": {}
    }
    ```

#### 3.2: Update logger.ts

- [ ] Add a `format` config option: `'text' | 'json'` (default: `'json'`)
- [ ] In each logger method (`info`, `warn`, `error`, `debug`): output JSON when format is `json`
- [ ] Keep text format as fallback for local development readability

#### 3.3: Update request logging

- [ ] Replace the template string log in the middleware (`src/index.ts` ~line 304) with a structured object passed to `logger.info()`
- [ ] Include all fields from schema: method, host, path, status, strategy, duration, cache status, queue wait time
- [ ] Remove emoji from JSON output (keep in text mode for readability)

#### 3.4: Config integration

- [ ] Add `logFormat?: 'text' | 'json'` to `GlobalConfig` — default `'json'` in production (Docker), `'text'` in dev
- [ ] Env var: `LOG_FORMAT=json|text`

## Documentation

- [ ] Update `readme.md` — document context pooling (no user config needed), render queue behavior (requests queued instead of rejected), new log format option
- [ ] Update `contributing.md` — document new `/health` response fields

## Questions & Doubts

1. **Context pool size**
    - Option A — Fixed at `parallelRenders` (1:1 mapping, simple)
    - Option B — Configurable separately (allows more contexts than concurrent renders for faster acquisition)
    - Recommendation: Option A — keep it simple, one context per render slot. No new config field needed.

2. **Log format default**
    - Option A — Default `json` everywhere (consistent, aggregator-friendly)
    - Option B — Default `text` in dev (`NODE_ENV=development`), `json` in Docker/production
    - Recommendation: Option B — developers need readable logs locally, production needs structured logs.

3. **Queue overflow behavior**
    - Option A — Return 503 Service Unavailable (back-pressure to load balancer)
    - Option B — Drop lowest-priority items to make room
    - Recommendation: Option A — 503 is honest and lets upstream (nginx/LB) handle retry/failover.
