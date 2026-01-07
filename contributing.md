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

3. **Cache** (`src/cache.ts`)

    - File-based caching system
    - Stores rendered HTML with metadata
    - Automatic cleanup of expired entries

4. **Config** (`src/config.ts`)

    - Loads `config.json`
    - Supports environment variable overrides
    - Merges global and per-host settings

5. **HTML Optimizer** (`src/htmlOptimizer.ts`)
    - Removes scripts/styles for SEO
    - Minifies HTML
    - Keeps essential content

### Request Flow

```
1. Request arrives with Origin header
2. Parse hostname from Origin
3. Find matching host config
4. Check if bot (user agent detection)
5. Determine rendering strategy:
   - smart-ssr: Render if bot, static if user
   - ssr: Always render
   - csr: Never render
6. If rendering:
   - Check cache first
   - If miss: Render with Playwright
   - Store in cache
   - Return HTML
7. If not rendering:
   - Serve static files directly
```

### Rendering Process

1. Launch browser context (reused across requests)
2. Create new page
3. Set `RenderX/1.0` user agent (prevents loops)
4. Set Origin header
5. Block non-essential resources (images, fonts)
6. Navigate to local URL (`http://localhost:{port}{path}`)
7. Wait for readiness (networkidle, selector, or load)
8. Extract HTML
9. Optimize HTML
10. Close page, return HTML

### Caching

-   **Storage**: Files in `.cache/` directory
-   **Key**: MD5 hash of `{device}:{url}`
-   **TTL**: Configurable per-host
-   **Cleanup**: Automatic on startup and periodic intervals

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
├── cache.ts          # File-based cache
├── logger.ts         # Logging utility
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
    "activeRequests": 0,
    "maxConcurrency": 3,
    "hosts": 1
}
```

### 2. Test Static File Serving

```bash
# Regular user request (should serve static files)
curl -H "Origin: https://my-app.com" \
     http://localhost:8080/
```

Should return HTML quickly (< 100ms).

### 3. Test Bot Rendering

```bash
# Bot request (should render)
curl -H "Origin: https://my-app.com" \
     -H "User-Agent: Googlebot" \
     http://localhost:8080/
```

First request: ~1-2s (rendering)
Subsequent requests: < 50ms (cached)

### 4. Check Logs

Configure logging level in `config.json`:

```json
{
    "logs": "all"
}
```

Logging options:

-   `"none"`: No request logs
-   `"ssr"`: Only SSR and SSR-CACHE logs (default)
-   `"all"`: All SSR and CSR logs

Restart server and check console output for:

-   Render times
-   Cache hits/misses
-   Errors

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
-   New rendering strategies
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
