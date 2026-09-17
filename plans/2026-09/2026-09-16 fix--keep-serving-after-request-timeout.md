# RenderX — Keep Serving After a Request Times Out

Fixes [#2](https://github.com/neilveil/renderx/issues/2): a burst of scanner probes against an SSR host ended the Node process, and Docker's health check reported a healthy container as unhealthy.

## Root cause

The timeout middleware answers `504` and aborts the render after 30s. `renderPage` caught the abort and returned `false`, so the route handler fell through to `sendStaticFile(res, indexPath)`, which called `res.setHeader` on the finished response. Express 4 does not catch a throw from an async handler; the `ERR_HTTP_HEADERS_SENT` became an unhandled rejection, and Node 20 exits on those. Two more windows had the same shape: a render that completed while the timeout fired during the cache write, and the same sequence in the `/render` endpoint.

The health check was unrelated but landed in the same report: the inline `node -e` probe read `PORT || 8080`, while the server also reads `port` from `config.json`.

## Changes

- `sendError` and `sendStaticFile` moved to `src/respond.ts` and return early when `res.headersSent`. This covers every static and error path with one guard.
- `renderPage` reports an aborted render as handled when the response is already answered, and checks `headersSent` after the cache write before sending. `/render` does the same in both places.
- `asyncHandler` wraps the five async handlers and routes a rejection to a new error middleware. It keeps the status body-parser or `sendFile` attached (`400`, `413`, `404`), logs only 5xx with the stack, leaves a finished response alone and destroys the socket of an unfinished one. Without this, any future throw in a handler would hang the request and end the process.
- `process.on('unhandledRejection')` logs instead of exiting, as a last line of defence for rejections outside any request.
- `requestTimeoutMs` in `config.json` or `REQUEST_TIMEOUT_MS` env replaces the hardcoded 30s. Needed by the regression test, and the one knob the reporter could not tune. Validated as a positive number; `parseInt` would have turned a typo into a 1ms timer that 504s everything.
- The timeout middleware now answers `504` before it aborts, so "aborted" structurally implies "answered" instead of relying on both happening in one tick.
- `src/healthcheck.ts` replaces the inline health probe and resolves the port through `getConfig()`.
- `describeError` in `logger.ts` turns an unknown throw into a string with its stack, since the JSON formatter keeps only an Error's message.

## Verification

- `test/request-timeout.test.mjs` reproduces the report without a browser: a 1ms request timeout plus an empty `PLAYWRIGHT_BROWSERS_PATH` makes the launch fail a few I/O hops after the timer fires, and the renderer reports any failure on an aborted signal as `Render aborted`. With the guards and the async safety net removed the suite fails with the exact `ERR_HTTP_HEADERS_SENT` stack and the process exits 1; with them it passes.
- `test/error-handling.test.mjs` posts malformed and oversized JSON to `/cache/invalidate` and expects `400` and `413` in the JSON error shape.
- `test/healthcheck.test.mjs` runs `dist/healthcheck.js` against a server whose port is set only in `config.json`, and checks that `PORT` still overrides it.
- Shared harness extracted to `test/helpers.mjs`; the host-resolution suite uses it unchanged. The harness strips every server-read env var from the fixture environment and fails fast with stderr when the server dies at boot.
- `npm test`: 19 tests, 4 suites, all passing in under a second.

## Review

Two passes, mine and a fresh-eyes agent, on the first version of this change. Fixed before commit: the error middleware turned body-parser's `400`/`413` into `500` and re-ended finished responses, which double-logged the request; `REQUEST_TIMEOUT_MS` was `parseInt`'d without validation; the cache-hit branch of `renderPage` lacked the guard; the timeout suite left a 10s timer running and its liveness assertion could not fail; `startServer` leaked the child on a slow boot.

## Files

- `src/index.ts`, `src/respond.ts` (new), `src/healthcheck.ts` (new), `src/config.ts`, `src/logger.ts`
- `Dockerfile`
- `test/helpers.mjs` (new), `test/request-timeout.test.mjs` (new), `test/error-handling.test.mjs` (new), `test/healthcheck.test.mjs` (new), `test/host-resolution.test.mjs`
- `changelog.md`, `readme.md`, `contributing.md`, `package.json` (1.1.2)

## Follow-ups

- Reply on the issue once released; the reporter's exit code 0 points at their orchestrator restarting the container on the failing health check, so both fixes matter to them.
- Pre-existing, found while tracing the abort path: if the boot-time browser launch fails, `initPool` never runs and every later render throws `No available context in pool` even after the browser launches on retry (`src/renderer.ts` `preLaunchBrowser`, `src/contextPool.ts`). Deserves its own issue.
- The other `parseInt` env reads in `src/config.ts` (`PORT`, `PARALLEL_RENDERS`, `TIMEOUT_MS`, `CACHE_CLEANUP_INTERVAL`) have the same NaN hole `requestTimeoutMs` just closed.
- The repo still carries the old `plans/tasks/` and `plans/done/` layout. Migrate to done-docs-only in its own `chore` commit; already on the joahquin-infra board.
