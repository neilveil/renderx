# Local Testing Plan

## Overview

Testing strategy for verifying both plans (v2 simplification + performance/reliability) work correctly in local development before deploying. Covers manual testing with the existing demo-app, automated test scripts, and what to verify at each phase.

## Impact Assessment

- **Scope**: Small
- **Risk**: Low
- **Affected Areas**: `makefile`, test scripts, `config.json`

## Prerequisites

- Node.js >= 18
- Playwright Chromium installed (`npx playwright install chromium`)
- Demo app built (`make build-demo-app`)

## Task Breakdown

### Phase 1: Update Makefile & Config for New Behavior

- [ ] Update `config.json` for testing (no `bots` field, strategy `ssr`):
    ```json
    {
      "strategy": "ssr",
      "cacheCleanupInterval": 2,
      "logs": "all",
      "logFormat": "text",
      "hosts": [
        {
          "source": "demo-app",
          "host": "demo-app.com"
        }
      ]
    }
    ```
- [ ] Update `makefile` — remove bot-dependent tests, add new test targets

### Phase 2: Test v2 Simplification (Plan 1)

#### 2.1: Verify maxConcurrency removal

- [ ] Start server: `npm run dev`
- [ ] Hit `/health` endpoint — confirm response has `parallelRenders` (not `maxConcurrency`)
    ```bash
    curl http://localhost:8080/health | jq
    ```
- [ ] Verify env var still works: `MAX_CONCURRENCY=5 npm run dev` → check `/health` shows `parallelRenders: 5`

#### 2.2: Verify bot detection removal

- [ ] Request without bot UA — should still get SSR (not just static):
    ```bash
    curl http://localhost:8080 -H "Origin: https://demo-app.com" -H "User-Agent: Mozilla/5.0"
    ```
    Expected: rendered HTML with page content (not just empty `<div id="root"></div>`)
- [ ] Request with old bot UA — should behave identically (no special treatment):
    ```bash
    curl http://localhost:8080 -H "Origin: https://demo-app.com" -H "User-Agent: Googlebot"
    ```
    Expected: same rendered HTML as above
- [ ] Verify no `bots` field in startup logs

#### 2.3: Verify smart-ssr backward compat

- [ ] Set `"strategy": "smart-ssr"` in `config.json`
- [ ] Start server → confirm deprecation warning logged on startup
- [ ] Confirm it behaves as `ssr` (renders for all requests)

#### 2.4: Verify log labels

- [ ] Request a page route → log should show `SSR` or `SSR-CACHE`
    ```bash
    curl http://localhost:8080/posts -H "Origin: https://demo-app.com"
    ```
- [ ] Request a static file → log should show `STATIC`
    ```bash
    curl http://localhost:8080/vite.svg -H "Origin: https://demo-app.com"
    ```
- [ ] Request same page again → log should show `SSR-CACHE`

#### 2.5: Verify /render endpoint (no bot gating)

- [ ] Call without bot UA — should render (not redirect):
    ```bash
    curl "http://localhost:8080/render?url=https://demo-app.com/posts"
    ```
    Expected: rendered HTML, not a 302 redirect

### Phase 3: Test Stale-While-Revalidate Cache

> Use short `cacheCleanupInterval: 2` (2 minutes) for fast iteration.

#### 3.1: Verify fresh cache hit

- [ ] Request a page → first request is `SSR` (fresh render)
- [ ] Request same page immediately → `SSR-CACHE` (fresh hit, `stale: false`)
- [ ] Check response time: second request should be <10ms

#### 3.2: Verify stale detection & background refresh

- [ ] Set `cacheCleanupInterval: 2` (2 min TTL, stale after 1 min)
- [ ] Render a page, wait ~65 seconds (past halfway)
- [ ] Request again → should get `SSR-CACHE` (instant response) + log shows `SSR-REFRESH` (background re-render triggered)
    ```bash
    # After waiting 65s:
    curl http://localhost:8080/posts -H "Origin: https://demo-app.com"
    ```
- [ ] Wait 2s for background render to complete
- [ ] Request again → `SSR-CACHE` with fresh timestamp (cache was updated)

#### 3.3: Verify cleanup only deletes old entries

- [ ] Render a page, wait full 4 minutes (2x TTL)
- [ ] Check `.cache/` directory — file should be deleted by cleanup
- [ ] Request page again → `SSR` (cold render, file was cleaned up)

#### 3.4: Verify deduplication

- [ ] Trigger stale scenario, fire 5 concurrent requests to same URL:
    ```bash
    for i in {1..5}; do curl http://localhost:8080/posts -H "Origin: https://demo-app.com" & done; wait
    ```
- [ ] Check logs: should see only ONE `SSR-REFRESH`, not 5

### Phase 4: Test Performance & Reliability (Plan 2)

#### 4.1: Verify context pooling

- [ ] Start server, check startup logs for pool initialization
- [ ] Fire multiple sequential requests — verify render times are consistent (no context creation spike)
    ```bash
    for i in {1..10}; do
      time curl -s http://localhost:8080/posts -H "Origin: https://demo-app.com" -o /dev/null
    done
    ```
- [ ] First request may be slower (cold pool), subsequent should be faster

#### 4.2: Verify render queue

- [ ] Set `parallelRenders: 2` in config
- [ ] Fire 5 concurrent requests to different pages:
    ```bash
    curl http://localhost:8080/ -H "Origin: https://demo-app.com" &
    curl http://localhost:8080/posts -H "Origin: https://demo-app.com" &
    curl http://localhost:8080/comments -H "Origin: https://demo-app.com" &
    curl http://localhost:8080/countries -H "Origin: https://demo-app.com" &
    curl http://localhost:8080/continents -H "Origin: https://demo-app.com" &
    wait
    ```
- [ ] All 5 should eventually succeed (queued, not rejected)
- [ ] Check `/health` — verify `queueDepth` field is present
- [ ] Verify queue overflow: set max queue to 2, fire 10 requests → some should get 503

#### 4.3: Verify JSON logs

- [ ] Set `LOG_FORMAT=json npm run dev`
- [ ] Fire a request → verify output is valid JSON:
    ```bash
    curl http://localhost:8080/posts -H "Origin: https://demo-app.com"
    ```
    Expected log: `{"ts":"...","method":"GET","host":"demo-app.com","path":"/posts","status":200,"strategy":"SSR","duration":1200}`
- [ ] Set `LOG_FORMAT=text npm run dev` → verify human-readable text logs

#### 4.4: Verify priority (stale-refresh doesn't block real requests)

- [ ] Set `parallelRenders: 1`
- [ ] Trigger a stale-refresh (background render occupies the slot)
- [ ] Immediately fire a real request → it should get queued with high priority and execute next (not wait behind other background refreshes)

### Phase 5: Update Makefile

- [ ] Replace old `test-csr` / `test-ssr` targets with new ones:
    ```makefile
    test-ssr:
    	@echo "Testing SSR /..."
    	@curl -s http://localhost:8080 -H "Origin: https://demo-app.com" | grep -q "<title>" && echo "PASS" || echo "FAIL"
    	@echo "Testing SSR /posts..."
    	@curl -s http://localhost:8080/posts -H "Origin: https://demo-app.com" | grep -q "post" && echo "PASS" || echo "FAIL"

    test-cache:
    	@echo "Testing SSR-CACHE..."
    	@curl -s http://localhost:8080 -H "Origin: https://demo-app.com" > /dev/null
    	@curl -s -o /dev/null -w "%{time_total}" http://localhost:8080 -H "Origin: https://demo-app.com"
    	@echo " (should be <0.01s)"

    test-static:
    	@echo "Testing STATIC..."
    	@curl -s http://localhost:8080/vite.svg -H "Origin: https://demo-app.com" -o /dev/null -w "%{http_code}" && echo " (should be 200)"

    test-health:
    	@curl -s http://localhost:8080/health | jq .

    test-all: test-ssr test-cache test-static test-health
    ```

## Notes

- All tests use `cacheCleanupInterval: 2` for fast iteration (stale after 1 min, cleanup after 4 min)
- For stale-while-revalidate tests, use `sleep` between requests to let time pass
- JSON log tests need `jq` installed for validation (`echo '...' | jq .`)
- Demo app routes: `/`, `/posts`, `/posts/:id`, `/comments`, `/countries`, `/continents`
