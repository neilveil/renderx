# Contributing to RenderX

## How RenderX Works

### Architecture

RenderX is a TypeScript service that uses Playwright to render client-side applications on-demand.

**Core Components:**

1. **Express Server** (`src/index.ts`)

    - Handles HTTP requests
    - Routes based on `Origin` header
    - Serves static files or triggers rendering

2. **Renderer** (`src/renderer.ts`)

    - Uses Playwright to execute JavaScript
    - Waits for page readiness
    - Optimizes HTML for SEO

3. **Context Pool** (`src/contextPool.ts`)

    - Pre-warmed browser contexts for lower latency
    - Recycles contexts after 50 renders or 10 minutes
    - Resets pages to `about:blank` on release

4. **Render Queue** (`src/renderQueue.ts`)

    - Priority queue (`high` for real requests, `low` for background refreshes)
    - Prevents rejection at capacity — requests wait in queue
    - Returns 503 only when queue overflows (3x `parallelRenders`)

5. **Cache** (`src/cache.ts`)

    - File-based caching with stale-while-revalidate
    - Stores rendered HTML with metadata (including `createdAt`)
    - Stale entries served instantly with background refresh
    - Automatic cleanup of entries older than 2x TTL

6. **Config** (`src/config.ts`)

    - Loads `config.json`
    - Supports environment variable overrides
    - Merges global and per-host settings

7. **Logger** (`src/logger.ts`)

    - Configurable format: `text` (human-readable) or `json` (structured)
    - Respects `logs` level setting

8. **HTML Optimizer** (`src/htmlOptimizer.ts`)
    - Removes scripts/styles for SEO
    - Minifies HTML
    - Keeps essential content

### Request Flow

```
1. Request arrives with Origin header
2. Parse hostname from Origin
3. Find matching host config
4. Check SSR flag:
   - ssr enabled (default): Check cache → render if miss
   - ssr disabled: Serve static files
5. If rendering:
   - Check cache (fresh/stale/miss)
   - If fresh hit: return cached HTML
   - If stale hit: return cached HTML + background refresh
   - If miss: render with Playwright, cache, return
6. If not rendering:
   - Serve static files directly
```

### Rendering Process

1. Acquire pre-warmed browser context from pool
2. Create new page
3. Set per-request `RenderX/1.0` user agent via route interception (prevents loops)
4. Set Origin header via route interception
5. Block non-essential resources (images, fonts)
6. Navigate to local URL (`http://localhost:{port}{path}`)
7. Wait for readiness (networkidle, selector, or load)
8. Extract HTML
9. Close page, release context back to pool

### Caching

-   **Storage**: Files in `.cache/` directory
-   **Key**: SHA-256 hash of `{device}:{url}`
-   **Stale-while-revalidate**: Entries go stale after half the TTL. Stale entries are served instantly, and a background re-render is triggered.
-   **Cleanup**: Entries older than 2x TTL are purged. Periodic cleanup runs at the configured interval.

## Development Setup

### Prerequisites

-   Node.js >= 18.0.0
-   npm

### Setup

```bash
# Clone repository
git clone <repository-url>
cd renderx

# Install dependencies
npm install

# Build TypeScript
npm run build
```

### Development

```bash
# Run with hot reload
npm run dev

# Type check
npm run type-check
```

### Project Structure

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

## How to Verify Everything Works

### 1. Build and Start

```bash
npm run build
npm start
```

Check health:

```bash
curl http://localhost:8080/health
```

Expected response:

```json
{
    "status": "ok",
    "activeRenders": 0,
    "parallelRenders": 10,
    "queueDepth": 0,
    "hosts": 1
}
```

### 2. Test SSR

```bash
# Any request to a page route triggers SSR
curl -H "Origin: https://my-app.com" \
     http://localhost:8080/
```

First request: ~1-2s (rendering)
Second request: < 50ms (cached)

### 3. Test Cache

```bash
# First request renders
curl -H "Origin: https://my-app.com" http://localhost:8080/ > /dev/null

# Second request should be fast (cached)
curl -s -o /dev/null -w "Cache response: %{time_total}s\n" \
     -H "Origin: https://my-app.com" http://localhost:8080/
```

### 4. Test Static

```bash
# Request to a file path serves static
curl -H "Origin: https://my-app.com" \
     http://localhost:8080/vite.svg
```

### 5. Check Logs

Configure logging level in `config.json`:

```json
{
    "logs": "all",
    "logFormat": "text"
}
```

Logging options:

-   `"none"`: No request logs
-   `"ssr"`: SSR, SSR-CACHE, and SSR-REFRESH logs (default)
-   `"all"`: All logs including STATIC

Log format options:

-   `"text"`: Human-readable with emojis (default in development)
-   `"json"`: Structured JSON for log aggregators (default in production)

## Contribution Guidelines

### Code Style

-   Use TypeScript strict mode
-   Follow existing code patterns
-   Add types for all functions
-   Use meaningful variable names

### Pull Requests

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Make changes
4. Commit changes (`git commit -m 'Add amazing feature'`)
5. Push to branch (`git push origin feature/amazing-feature`)
6. Open Pull Request

### Commit Messages

Use clear, descriptive messages:

-   `fix: resolve cache cleanup issue`
-   `feat: add new wait strategy`
-   `docs: update README`

### What to Contribute

-   Bug fixes
-   Performance improvements
-   Better error handling
-   Documentation improvements

## Troubleshooting

### Server won't start

-   Check Node.js version: `node --version` (needs >= 18)
-   Check port availability
-   Verify `config.json` is valid JSON

### Rendering not working

-   Check Playwright installed: `npx playwright install chromium`
-   Verify host config is active
-   Check browser logs (set `logs: "all"` in config)

### Cache issues

-   Check `.cache/` directory permissions
-   Verify disk space available
-   Clear cache: `rm -rf .cache/`

## Questions?

-   Check existing issues
-   Review code comments
-   Ask in discussions
