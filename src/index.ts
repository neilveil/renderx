import { randomUUID } from 'crypto'
import express, { NextFunction, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import cache, { startCleanupInterval, stopCleanupInterval } from './cache'
import { getConfig, getEffectiveConfig, getHostConfig, HostConfig, RenderingStrategy } from './config'
import { logger } from './logger'
import { getActiveRequests, preLaunchBrowser, render } from './renderer'

const app = express()
const globalConfig = getConfig()

// Constants
const REQUEST_TIMEOUT_MS = 30000 // 30 seconds
const RENDERX_USER_AGENT = 'RenderX/1.0'

// Rate limiting: Simple in-memory store
interface RateLimitStore {
    count: number
    resetTime: number
}

const rateLimitStore = new Map<string, RateLimitStore>()
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const RATE_LIMIT_MAX_REQUESTS = 100 // Max requests per window

/**
 * Simple rate limiting middleware
 */
const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const clientId = req.ip || req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    const store = rateLimitStore.get(clientId)

    if (!store || now > store.resetTime) {
        // New window or expired
        rateLimitStore.set(clientId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS })
        return next()
    }

    if (store.count >= RATE_LIMIT_MAX_REQUESTS) {
        res.status(429).json({
            error: 'Too many requests',
            message: `Rate limit exceeded. Maximum ${RATE_LIMIT_MAX_REQUESTS} requests per ${
                RATE_LIMIT_WINDOW_MS / 1000 / 60
            } minutes.`
        })
        return
    }

    store.count++
    next()
}

// Clean up old rate limit entries periodically
setInterval(() => {
    const now = Date.now()
    for (const [key, value] of rateLimitStore.entries()) {
        if (now > value.resetTime) {
            rateLimitStore.delete(key)
        }
    }
}, RATE_LIMIT_WINDOW_MS)

/**
 * Request ID middleware - adds unique ID to each request for tracing
 */
const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const requestId = randomUUID()
    ;(req as Request & { id: string }).id = requestId
    res.setHeader('X-Request-ID', requestId)
    next()
}

/**
 * Standardized error response helper
 */
const sendError = (res: Response, statusCode: number, error: string, message?: string): void => {
    const response: { error: string; message?: string } = { error }
    if (message) {
        response.message = message
    }
    res.status(statusCode).json(response)
}

/**
 * Validates and normalizes a file path to prevent path traversal attacks
 * @param basePath - Base directory path
 * @param requestedPath - Requested file path
 * @returns Normalized path if valid, null if invalid
 */
const validatePath = (basePath: string, requestedPath: string): string | null => {
    // Strip leading slash to treat Express paths as relative to base directory
    // Express req.path always starts with /, but we want to treat it as relative
    const relativePath = requestedPath.startsWith('/') ? requestedPath.slice(1) : requestedPath

    // Normalize the path
    const normalizedPath = path.normalize(relativePath)

    // Prevent path traversal - check for .. after normalization
    // Also prevent absolute paths (though this shouldn't happen after stripping leading /)
    if (normalizedPath.includes('..') || path.isAbsolute(normalizedPath)) {
        return null
    }

    // Resolve to absolute path
    const resolvedPath = path.resolve(basePath, normalizedPath)
    const resolvedBase = path.resolve(basePath)

    // Ensure resolved path is within base directory
    if (!resolvedPath.startsWith(resolvedBase)) {
        return null
    }

    return resolvedPath
}

/**
 * Validates origin header against configured hosts to prevent SSRF
 * @param origin - Origin header value
 * @returns true if origin is valid, false otherwise
 */
const isValidOrigin = (origin: string): boolean => {
    try {
        const originUrl = new URL(origin)
        const hostname = originUrl.hostname

        // Check if hostname matches any configured host
        const hostConfig = getHostConfig(hostname)
        return hostConfig !== null
    } catch {
        return false
    }
}

/**
 * Validates URL to prevent SSRF attacks
 * Allows localhost for local development/testing, but blocks private IP ranges
 * @param url - URL to validate
 * @returns true if URL is safe, false otherwise
 */
const isSafeUrl = (url: URL): boolean => {
    const hostname = url.hostname.toLowerCase()

    // Allow localhost for local development/testing
    // Block other loopback addresses that could be used for SSRF
    const blockedLoopback = ['127.0.0.1', '0.0.0.0', '::1', '[::1]']
    if (blockedLoopback.includes(hostname)) {
        return false
    }

    // Block private IP ranges (still protect against internal network access)
    // Check if hostname is in 172.16.0.0/12 range (172.16.0.0 - 172.31.255.255)
    const parts = hostname.split('.').map(Number)
    if (
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') ||
        (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    ) {
        return false
    }

    return true
}

/**
 * Request timeout middleware
 */
app.use((_req: Request, res: Response, next: NextFunction) => {
    const timeout = setTimeout(() => {
        if (!res.headersSent) {
            sendError(res, 504, 'Request timeout', 'The request took too long to process')
        }
    }, REQUEST_TIMEOUT_MS)

    // Clear timeout when response is sent
    const originalEnd = res.end.bind(res)
    res.end = function (chunk?: any, encoding?: any) {
        clearTimeout(timeout)
        return originalEnd(chunk, encoding)
    }

    next()
})

// Pre-launch browser to avoid cold start delays
preLaunchBrowser().catch(err => {
    logger.error('Failed to pre-launch browser:', err)
})

// Start automatic cache cleanup (clears cache on startup if configured, then periodic cleanup)
// cacheCleanupInterval is in minutes
startCleanupInterval(globalConfig.cacheCleanupInterval || 60, globalConfig.clearCacheOnStartup ?? true).catch(err => {
    logger.error('Failed to start cache cleanup:', err)
})

// Middleware
app.use(express.json())

// Request ID middleware (must be early in the chain)
app.use(requestIdMiddleware)

// Rate limiting for /render endpoint
app.use('/render', rateLimitMiddleware)

// Request/Response logging middleware
app.use((req: Request, res: Response, next: () => void) => {
    const startTime = Date.now()
    const origin = req.headers.origin
    const host = req.headers.host?.split(':')[0] || 'unknown'
    const userAgent = req.headers['user-agent'] || ''
    const isRenderXRequest = userAgent.toLowerCase().includes('renderx')
    const isInternalRender = req.headers['x-renderx-internal'] === 'true'
    const isFileRequest = isFilePath(req.path)

    // Determine hostname for logging
    let hostname = 'unknown'
    if (origin) {
        try {
            const originUrl = new URL(origin)
            hostname = originUrl.hostname
        } catch {
            hostname = host
        }
    } else {
        hostname = host
    }

    // Get effective config to determine strategy
    let strategy = 'csr' // default
    let matchedBot: string | null = null
    try {
        const effectiveConfig = getEffectiveConfig(hostname)
        const userAgentLower = userAgent.toLowerCase()

        // Find which bot matched (if any)
        matchedBot =
            effectiveConfig.bots.find(bot => {
                return userAgentLower.includes(bot.toLowerCase())
            }) || null

        const isBot = matchedBot !== null

        // Determine actual serving strategy
        if (isInternalRender || isRenderXRequest || isFileRequest) {
            strategy = 'csr' // Files are always CSR
        } else {
            switch (effectiveConfig.renderingStrategy) {
                case 'ssr':
                    strategy = 'ssr'
                    break
                case 'csr':
                    strategy = 'csr'
                    break
                case 'smart-ssr':
                default:
                    strategy = isBot ? 'ssr' : 'csr'
                    break
            }
        }
    } catch {
        // If config lookup fails, default to csr
        strategy = 'csr'
    }

    // Store matched bot in response for logging
    ;(res as Response & { _matchedBot?: string | null })._matchedBot = matchedBot

    // Override res.end to capture status code
    const originalEnd = res.end.bind(res)
    res.end = function (chunk?: any, encoding?: any) {
        const duration = Date.now() - startTime
        const statusCode = res.statusCode
        const statusEmoji = statusCode >= 500 ? '❌' : statusCode >= 400 ? '⚠️' : statusCode >= 300 ? '↩️' : '✅'
        const timestamp = new Date().toISOString()

        // Format path with leading slash if needed
        const path = req.path.startsWith('/') ? req.path : `/${req.path}`

        // Determine if response was from cache (for SSR strategy)
        const cacheHit = (res as Response & { _cacheHit?: boolean })._cacheHit
        const cacheHeader = res.getHeader('X-Cache')
        const isCacheHit = cacheHit === true || cacheHeader === 'HIT'
        const matchedBot = (res as Response & { _matchedBot?: string | null })._matchedBot

        // Update strategy to show cache status for SSR
        let displayStrategy = strategy.toUpperCase()
        if (strategy === 'ssr' && isCacheHit) {
            displayStrategy = 'SSR-CACHE'
        }

        // Add bot name in brackets for SSR/SSR-CACHE if bot was matched
        // Show the actual bot name from config (not lowercased)
        if ((strategy === 'ssr' || displayStrategy === 'SSR-CACHE') && matchedBot) {
            displayStrategy = `${displayStrategy} (${matchedBot})`
        }

        // Check logs setting to determine if we should log this request
        const effectiveConfig = getEffectiveConfig(hostname)
        const logsLevel = effectiveConfig.logs ?? 'ssr'
        const shouldLog = logsLevel === 'all' || (logsLevel === 'ssr' && displayStrategy.startsWith('SSR'))

        if (shouldLog) {
            logger.info(
                `${timestamp} ${statusEmoji} ${req.method} ${hostname}${path} | ${statusCode} | ${displayStrategy} | ${duration}ms`
            )
        }

        return originalEnd(chunk, encoding)
    }

    next()
})

// Health check endpoint
app.get('/health', async (_req: Request, res: Response) => {
    const config = getEffectiveConfig()
    const health: {
        status: string
        activeRequests: number
        maxConcurrency: number
        hosts: number
        browser?: { available: boolean; error?: string }
        cache?: { writable: boolean; error?: string }
    } = {
        status: 'ok',
        activeRequests: getActiveRequests(),
        maxConcurrency: config.maxConcurrency,
        hosts: globalConfig.hosts.length
    }

    // Check browser availability
    try {
        await import('./renderer').then(m => m.preLaunchBrowser())
        health.browser = { available: true }
    } catch (err) {
        const error = err as Error
        health.browser = { available: false, error: error.message }
    }

    // Check cache directory writability
    try {
        const cacheDir = process.env.CACHE_DIR || '.cache'
        const cachePath = path.isAbsolute(cacheDir) ? cacheDir : path.join(process.cwd(), cacheDir)
        await fs.promises.access(cachePath, fs.constants.W_OK).catch(() => {
            // Try to create directory if it doesn't exist
            return fs.promises.mkdir(cachePath, { recursive: true })
        })
        health.cache = { writable: true }
    } catch (err) {
        const error = err as Error
        health.cache = { writable: false, error: error.message }
        health.status = 'degraded'
    }

    const statusCode = health.status === 'ok' ? 200 : 503
    res.status(statusCode).json(health)
})

/**
 * Helper function to check if a path is a file (has extension)
 */
const isFilePath = (filePath: string): boolean => {
    const ext = path.extname(filePath)
    return ext !== '' && ext !== '/'
}

/**
 * Determines if we should render based on strategy
 */
const shouldRender = (
    strategy: RenderingStrategy,
    isBot: boolean,
    isRenderXRequest: boolean,
    isDirectFile: boolean,
    isInternalRender: boolean = false
): boolean => {
    // Never render internal render requests (to avoid loops)
    if (isInternalRender) {
        return false
    }

    // Never render RenderX requests (to avoid loops)
    if (isRenderXRequest) {
        return false
    }

    // Never render direct file paths
    if (isDirectFile) {
        return false
    }

    switch (strategy) {
        case 'csr':
            // CSR: Never render, always serve index.html
            return false
        case 'ssr':
            // SSR: Always render (except for direct files and RenderX requests)
            return true
        case 'smart-ssr':
        default:
            // Smart SSR: Only render for bots
            return isBot
    }
}

/**
 * Renders a page and handles caching
 * @param res - Express response object
 * @param cacheKey - Cache key for this request
 * @param localUrl - Local URL to render
 * @param origin - Origin header value
 * @param effectiveConfig - Effective configuration
 * @returns true if response was sent, false otherwise
 */
const renderPage = async (
    res: Response,
    cacheKey: string,
    localUrl: string,
    origin: string | undefined,
    effectiveConfig: ReturnType<typeof getEffectiveConfig>
): Promise<boolean> => {
    // Check cache first
    const cachedHtml = await cache.get(cacheKey, 'desktop')
    if (cachedHtml) {
        // Mark as cache hit for logging
        ;(res as Response & { _cacheHit?: boolean })._cacheHit = true
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.send(cachedHtml)
        return true
    }

    // Render the page
    try {
        const html = await render(
            localUrl,
            {
                timeoutMs: effectiveConfig.timeoutMs,
                maxConcurrency: effectiveConfig.maxConcurrency,
                rootSelector: effectiveConfig.rootSelector,
                htmlOptimizerOptions: effectiveConfig.htmlOptimizerOptions,
                strategy: effectiveConfig.renderingStrategy
            },
            RENDERX_USER_AGENT,
            origin
        )

        if (html) {
            await cache.set(cacheKey, html, 'desktop', effectiveConfig.cacheTtl)
            // Mark as cache miss (fresh render) for logging
            ;(res as Response & { _cacheHit?: boolean })._cacheHit = false
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.send(html)
            return true
        }
    } catch (err) {
        logger.error('Render error:', err)
        // Fallback to serving index.html
    }

    return false
}

// Main routing middleware - handles origin-based routing
app.use(async (req: Request, res: Response, next: () => void) => {
    // Extract headers
    const origin = req.headers.origin
    const userAgent = req.headers['user-agent'] || ''
    const isRenderXRequest = userAgent.toLowerCase().includes('renderx')
    const isInternalRender = req.headers['x-renderx-internal'] === 'true'

    // Check if this is a file request (has file extension)
    const isFileRequest = isFilePath(req.path)

    // For internal render requests, serve files/assets directly without origin check
    if (isInternalRender) {
        // Determine which host to use - prioritize Origin header if present
        let targetHostConfig: HostConfig | null = null

        if (origin) {
            try {
                const originUrl = new URL(origin)
                const originHostname = originUrl.hostname
                targetHostConfig = getHostConfig(originHostname)
            } catch {
                // Invalid origin format, continue to Host header fallback
            }
        }

        // If no host found from origin, try Host header
        if (!targetHostConfig) {
            const hostname = req.headers.host?.split(':')[0] || ''
            if (hostname) {
                targetHostConfig = getHostConfig(hostname)
            }
        }

        // If we found a host config, try that first
        if (targetHostConfig && targetHostConfig.isActive !== false) {
            const sourcePath = path.join(process.cwd(), './hosts', targetHostConfig.source)
            const validatedFilePath = validatePath(sourcePath, req.path)

            if (validatedFilePath && fs.existsSync(validatedFilePath)) {
                const stats = fs.statSync(validatedFilePath)
                if (stats.isFile()) {
                    return res.sendFile(validatedFilePath)
                }
                // Check if directory with index.html
                if (stats.isDirectory()) {
                    const indexPath = path.join(validatedFilePath, 'index.html')
                    if (fs.existsSync(indexPath)) {
                        return res.sendFile(indexPath)
                    }
                }
            }

            // For page requests, serve index.html
            if (!isFileRequest) {
                const indexPath = path.join(sourcePath, 'index.html')
                if (fs.existsSync(indexPath)) {
                    return res.sendFile(indexPath)
                }
            }
        }

        // Fallback: Try each configured host to find the file
        for (const hostConfig of globalConfig.hosts) {
            if (hostConfig.isActive === false) continue
            if (targetHostConfig && hostConfig.source === targetHostConfig.source) continue

            const sourcePath = path.join(process.cwd(), './hosts', hostConfig.source)
            const validatedFilePath = validatePath(sourcePath, req.path)

            if (validatedFilePath && fs.existsSync(validatedFilePath)) {
                const stats = fs.statSync(validatedFilePath)
                if (stats.isFile()) {
                    return res.sendFile(validatedFilePath)
                }
                // Check if directory with index.html
                if (stats.isDirectory()) {
                    const indexPath = path.join(validatedFilePath, 'index.html')
                    if (fs.existsSync(indexPath)) {
                        return res.sendFile(indexPath)
                    }
                }
            }
        }

        // For page requests during internal render, serve index.html from first active host
        if (!isFileRequest) {
            for (const hostConfig of globalConfig.hosts) {
                if (hostConfig.isActive === false) continue
                const sourcePath = path.join(process.cwd(), './hosts', hostConfig.source)
                const indexPath = path.join(sourcePath, 'index.html')
                if (fs.existsSync(indexPath)) {
                    return res.sendFile(indexPath)
                }
            }
        }

        return sendError(res, 404, 'Not found')
    }

    // For file requests without internal header, try to serve from all configured hosts
    if (isFileRequest && !origin) {
        // Try each configured host to find the file
        for (const hostConfig of globalConfig.hosts) {
            if (hostConfig.isActive === false) continue

            const sourcePath = path.join(process.cwd(), './hosts', hostConfig.source)
            const validatedFilePath = validatePath(sourcePath, req.path)

            if (validatedFilePath && fs.existsSync(validatedFilePath) && fs.statSync(validatedFilePath).isFile()) {
                return res.sendFile(validatedFilePath)
            }
        }
        // File not found in any host, continue to normal routing
    }

    // Parse origin to get hostname (fallback to Host header when Origin is not present)
    // Note: Same-origin navigation requests don't send Origin header, so we use Host header
    let originHostname: string
    let originUrl: URL | null = null

    if (origin) {
        try {
            originUrl = new URL(origin)
            originHostname = originUrl.hostname

            // Validate origin against configured hosts
            if (!isValidOrigin(origin)) {
                return sendError(res, 403, 'Invalid origin', 'Origin does not match any configured host')
            }
        } catch (err) {
            return sendError(res, 400, 'Invalid Origin header format')
        }
    } else {
        // Fallback to Host header when Origin is not present (common for same-origin navigation)
        originHostname = req.headers.host?.split(':')[0] || ''
        if (!originHostname) {
            return sendError(res, 400, 'Unable to determine hostname')
        }
    }

    // Find host config matching the origin/host
    const hostConfig = getHostConfig(originHostname)

    // If no host config found, validate Host header and return appropriate error
    if (!hostConfig) {
        // If Origin was present but invalid, we already returned 403 above
        // If Host header was used but doesn't match, return 403 for consistency
        if (!origin) {
            return sendError(res, 403, 'Invalid host', 'Host does not match any configured host')
        }
        // If Origin was present but hostConfig is null, try /render endpoint or 404
        return next()
    }

    // Check if host is active (defaults to true if not specified)
    if (hostConfig.isActive === false) {
        return sendError(res, 503, 'Host is not active')
    }

    const effectiveConfig = getEffectiveConfig(originHostname)
    const isBot = effectiveConfig.bots.some(bot => {
        return userAgent.toLowerCase().includes(bot.toLowerCase())
    })

    // Serve static files from source directory
    const sourcePath = path.join(process.cwd(), effectiveConfig.hostsDir, hostConfig.source)

    // Handle root path - serve index.html if present, else 404
    if (req.path === '/') {
        const indexPath = path.join(sourcePath, 'index.html')

        if (fs.existsSync(indexPath)) {
            // Check if we should render based on strategy
            if (shouldRender(effectiveConfig.renderingStrategy, isBot, isRenderXRequest, false, isInternalRender)) {
                // Construct cache key using the origin URL
                const cacheKey = origin
                    ? `${origin}${req.originalUrl}`
                    : `${req.protocol}://${originHostname}${req.originalUrl}`

                // Construct local URL pointing to Express server
                const localUrl = `http://localhost:${globalConfig.port}${req.originalUrl}`

                const rendered = await renderPage(res, cacheKey, localUrl, origin || undefined, effectiveConfig)
                if (rendered) {
                    return
                }
            }
            return res.sendFile(indexPath)
        }
        return sendError(res, 404, 'Not found', `index.html not found in source directory: ${sourcePath}`)
    }

    // Check if requesting a direct file path - validate to prevent path traversal
    // Always check for file existence first, even for paths starting with /
    // This ensures assets like /assets/index.js are served correctly
    const validatedFilePath = validatePath(sourcePath, req.path)
    if (validatedFilePath && fs.existsSync(validatedFilePath)) {
        if (fs.statSync(validatedFilePath).isFile()) {
            // Direct file - serve it directly
            return res.sendFile(validatedFilePath)
        }

        // Check if directory with index.html
        if (fs.statSync(validatedFilePath).isDirectory()) {
            const indexPath = path.join(validatedFilePath, 'index.html')
            if (fs.existsSync(indexPath)) {
                return res.sendFile(indexPath)
            }
        }
    }

    // For SPA routes (not file paths), serve index.html if present
    const indexPath = path.join(sourcePath, 'index.html')
    if (fs.existsSync(indexPath)) {
        // Check if we should render based on strategy
        const isDirectFile = isFilePath(req.path)
        if (shouldRender(effectiveConfig.renderingStrategy, isBot, isRenderXRequest, isDirectFile, isInternalRender)) {
            // Construct cache key using the origin URL
            const cacheKey = origin
                ? `${origin}${req.originalUrl}`
                : `${req.protocol}://${originHostname}${req.originalUrl}`

            // Construct local URL pointing to Express server
            const localUrl = `http://localhost:${globalConfig.port}${req.originalUrl}`

            const rendered = await renderPage(res, cacheKey, localUrl, origin || undefined, effectiveConfig)
            if (rendered) {
                return
            }
        }

        return res.sendFile(indexPath)
    }

    return sendError(res, 404, 'Not found')
})

// Legacy /render endpoint
app.get('/render', async (req: Request, res: Response) => {
    try {
        const url = req.query.url as string | undefined

        if (!url) {
            return sendError(res, 400, 'Missing required parameter: url')
        }

        // Validate URL format
        let parsedUrl: URL
        try {
            parsedUrl = new URL(url)
        } catch (err) {
            return sendError(res, 400, 'Invalid URL format')
        }

        // SSRF protection - validate URL is safe
        if (!isSafeUrl(parsedUrl)) {
            return sendError(res, 400, 'Invalid URL', 'Internal/localhost URLs are not allowed')
        }

        const hostname = parsedUrl.hostname
        const effectiveConfig = getEffectiveConfig(hostname)
        const userAgent = req.headers['user-agent'] || ''
        const isBot = effectiveConfig.bots.some(bot => {
            return userAgent.toLowerCase().includes(bot.toLowerCase())
        })

        if (effectiveConfig.botOnly && !isBot) {
            return res.redirect(url)
        }

        const deviceType = (req.query.device as string | undefined) || 'desktop'

        // Check cache first
        const cachedHtml = await cache.get(url, deviceType)
        if (cachedHtml) {
            res.set('X-Cache', 'HIT')
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            return res.send(cachedHtml)
        }

        // Render the page - use RenderX user agent to avoid SSR loop
        // For /render endpoint, use already parsed URL to get origin and construct local URL
        const localUrl = `http://localhost:${globalConfig.port}${parsedUrl.pathname}${parsedUrl.search}`
        const origin = `${parsedUrl.protocol}//${parsedUrl.host}`

        const html = await render(
            localUrl,
            {
                timeoutMs: effectiveConfig.timeoutMs,
                maxConcurrency: effectiveConfig.maxConcurrency,
                rootSelector: effectiveConfig.rootSelector,
                htmlOptimizerOptions: effectiveConfig.htmlOptimizerOptions,
                strategy: effectiveConfig.renderingStrategy
            },
            'RenderX/1.0', // Use RenderX user agent to avoid SSR loop
            origin // Pass origin header so Express knows which host to serve
        )

        if (!html) {
            return sendError(res, 500, 'Failed to render page')
        }

        // Store in cache
        await cache.set(url, html, deviceType, effectiveConfig.cacheTtl)
        res.set('X-Cache', 'MISS')
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.send(html)
    } catch (err) {
        const error = err as Error
        logger.error('Render endpoint error:', error)

        if (req.query.url) {
            res.set('X-Render-Error', error.message)
            return res.redirect(req.query.url as string)
        }

        sendError(res, 500, 'Internal server error', error.message)
    }
})

// Cache management endpoints
app.post('/cache/invalidate', async (req: Request, res: Response) => {
    const { url, device } = req.body as { url?: string; device?: string }

    if (!url) {
        return sendError(res, 400, 'Missing required parameter: url')
    }

    // Validate URL format
    try {
        new URL(url)
    } catch {
        return sendError(res, 400, 'Invalid URL format')
    }

    // Validate device type
    const validDevices = ['desktop', 'mobile', 'tablet']
    const deviceType = device && validDevices.includes(device) ? device : 'desktop'

    const result = await cache.invalidate(url, deviceType)
    return res.json({ success: result })
})

app.post('/cache/clear', async (_req: Request, res: Response) => {
    const result = await cache.clear()
    return res.json({ success: result })
})

// Start server
const PORT = globalConfig.port
app.listen(PORT, () => {
    // Server start logs always shown regardless of logs setting
    console.log(`RenderX server listening on port ${PORT}`)
    console.log(`Configuration:`)
    console.log(`  Hosts: ${globalConfig.hosts.length}`)
    console.log(`  Strategy: ${globalConfig.strategy}`)
    console.log(`  Parallel Renders: ${globalConfig.parallelRenders}`)
    const cacheCleanupInterval = globalConfig.cacheCleanupInterval || 60
    console.log(`  Cache Cleanup Interval: ${cacheCleanupInterval} minutes`)
    console.log(`  Cache Directory: ${process.env.CACHE_DIR || '.cache'}`)
    console.log(`  Hosts Directory: ./hosts`)
    console.log(`  Bots: ${globalConfig.bots.length} configured`)
    const logsLevel = globalConfig.logs ?? 'ssr'
    console.log(`  Logs Level: ${logsLevel}`)
    globalConfig.hosts.forEach(host => {
        const isActive = host.isActive ?? true
        console.log(`  - ${host.host} -> ${host.source} (${isActive ? 'active' : 'inactive'})`)
    })
})

// Graceful shutdown
process.on('SIGTERM', () => {
    stopCleanupInterval()
    process.exit(0)
})

process.on('SIGINT', () => {
    stopCleanupInterval()
    process.exit(0)
})
