import { randomUUID } from 'crypto'
import express, { NextFunction, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import cache, { startCleanupInterval, stopCleanupInterval } from './cache'
import {
    decodeRequestPath,
    getConfig,
    getEffectiveConfig,
    getHostConfig,
    HostConfig,
    INTERNAL_RENDER_TOKEN,
    isSsrExcludedPath
} from './config'
import { logger } from './logger'
import { isBrowserReady, preLaunchBrowser, render } from './renderer'
import { enqueue, getQueueStats } from './renderQueue'

const app = express()
const globalConfig = getConfig()

// Constants
const REQUEST_TIMEOUT_MS = 30000
const RENDERX_USER_AGENT = 'RenderX/1.0'

// Rate limiting
type RateLimitStore = {
    count: number
    resetTime: number
}

const rateLimitStore = new Map<string, RateLimitStore>()
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const RATE_LIMIT_MAX_REQUESTS = 100

const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const clientId = req.ip || req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    const store = rateLimitStore.get(clientId)

    if (!store || now > store.resetTime) {
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

setInterval(() => {
    const now = Date.now()
    for (const [key, value] of rateLimitStore.entries()) {
        if (now > value.resetTime) {
            rateLimitStore.delete(key)
        }
    }
}, RATE_LIMIT_WINDOW_MS)

const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const requestId = randomUUID()
    ;(req as Request & { id: string }).id = requestId
    res.setHeader('X-Request-ID', requestId)
    next()
}

const sendError = (res: Response, statusCode: number, error: string, message?: string): void => {
    const response: { error: string; message?: string } = { error }
    if (message) {
        response.message = message
    }
    res.status(statusCode).json(response)
}

const validatePath = (basePath: string, requestedPath: string): string | null => {
    // Assets whose filenames contain spaces or parentheses (common in Vite builds) only
    // resolve on disk once the request path is decoded.
    const decodedPath = decodeRequestPath(requestedPath)
    if (decodedPath === null) {
        logger.warn(`Rejected malformed request path: ${requestedPath}`)
        return null
    }

    // Null bytes truncate paths in some syscalls and are never legitimate
    if (decodedPath.includes('\0')) {
        return null
    }

    const relativePath = decodedPath.startsWith('/') ? decodedPath.slice(1) : decodedPath
    const normalizedPath = path.normalize(relativePath)

    // Traversal is checked after decoding so an encoded "%2e%2e" cannot slip past it
    if (normalizedPath.includes('..') || path.isAbsolute(normalizedPath)) {
        return null
    }

    const resolvedPath = path.resolve(basePath, normalizedPath)
    const resolvedBase = path.resolve(basePath)

    // Compare against the base plus a separator so "hosts/app" cannot match "hosts/app-other"
    if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + path.sep)) {
        return null
    }

    return resolvedPath
}

const isValidOrigin = (origin: string): boolean => {
    try {
        const originUrl = new URL(origin)
        const hostname = originUrl.hostname
        const hostConfig = getHostConfig(hostname)
        return hostConfig !== null
    } catch {
        return false
    }
}

const isSafeUrl = (url: URL): boolean => {
    const hostname = url.hostname.toLowerCase()

    const blockedLoopback = ['127.0.0.1', '0.0.0.0', '::1', '[::1]']
    if (blockedLoopback.includes(hostname)) {
        return false
    }

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

// Known scanner/bot paths that should never trigger SSR
const SCANNER_PATH_PATTERNS = [
    /\.php$/i,
    /\/wp-/i,
    /\/xmlrpc/i,
    /\/HNAP/i,
    /\/cgi-bin/i,
    /\/\.env/i,
    /\/\.git/i,
    /\/\.well-known\/security/i,
    /\/admin\/?$/i,
    /\/administrator/i,
    /\/phpmyadmin/i,
    /\/config\.(json|yml|yaml|xml|ini|bak)$/i
]

const isScannerPath = (reqPath: string): boolean => {
    return SCANNER_PATH_PATTERNS.some(pattern => pattern.test(reqPath))
}

// Request timeout middleware with AbortController for render cancellation
app.use((_req: Request, res: Response, next: NextFunction) => {
    const controller = new AbortController()
    ;(res as Response & { renderAbortSignal: AbortSignal }).renderAbortSignal = controller.signal

    const timeout = setTimeout(() => {
        controller.abort()
        if (!res.headersSent) {
            sendError(res, 504, 'Request timeout', 'The request took too long to process')
        }
    }, REQUEST_TIMEOUT_MS)

    const originalEnd = res.end.bind(res)
    res.end = function (chunk?: any, encoding?: any) {
        clearTimeout(timeout)
        return originalEnd(chunk, encoding)
    }

    next()
})

// Pre-launch browser
preLaunchBrowser().catch(err => {
    logger.error('Failed to pre-launch browser:', err)
})

// Start cache cleanup
startCleanupInterval(globalConfig.cacheCleanupInterval || 60, globalConfig.clearCacheOnStartup ?? true).catch(err => {
    logger.error('Failed to start cache cleanup:', err)
})

app.use(express.json())
app.use(requestIdMiddleware)
app.use('/render', rateLimitMiddleware)

// Request/Response logging middleware
app.use((req: Request, res: Response, next: () => void) => {
    const startTime = Date.now()
    const origin = req.headers.origin
    const host = req.headers.host?.split(':')[0] || 'unknown'
    const isInternalRender = req.headers['x-renderx-internal'] === INTERNAL_RENDER_TOKEN
    const isFileRequest = isFilePath(req.path)

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

    const managementPaths = ['/health', '/render', '/cache/invalidate', '/cache/clear']
    let strategy = 'static'
    try {
        if (isInternalRender || isFileRequest || managementPaths.includes(req.path)) {
            strategy = 'static'
        } else {
            const effectiveConfig = getEffectiveConfig(hostname)
            const isCsrOnlyRoute = isSsrExcludedPath(effectiveConfig.ssrExclude, req.path)
            strategy = effectiveConfig.ssr && !isCsrOnlyRoute ? 'ssr' : 'static'
        }
    } catch {
        strategy = 'static'
    }

    const originalEnd = res.end.bind(res)
    res.end = function (chunk?: any, encoding?: any) {
        const duration = Date.now() - startTime
        const statusCode = res.statusCode
        const requestPath = req.path.startsWith('/') ? req.path : `/${req.path}`

        const cacheHit = (res as Response & { _cacheHit?: boolean })._cacheHit
        const cacheHeader = res.getHeader('X-Cache')
        const isCacheHit = cacheHit === true || cacheHeader === 'HIT'

        let displayStrategy = strategy.toUpperCase()
        if (strategy === 'ssr' && isCacheHit) {
            displayStrategy = 'SSR-CACHE'
        }

        const effectiveConfig = getEffectiveConfig(hostname)
        const logsLevel = effectiveConfig.logs ?? 'ssr'
        const shouldLog = logsLevel === 'all' || (logsLevel === 'ssr' && displayStrategy.startsWith('SSR'))

        if (shouldLog) {
            const logFormat = effectiveConfig.logFormat

            if (logFormat === 'json') {
                // Structured JSON log
                const cacheStatus = strategy === 'ssr' ? (isCacheHit ? 'HIT' : 'MISS') : undefined
                logger.info(
                    JSON.stringify({
                        ts: new Date().toISOString(),
                        method: req.method,
                        host: hostname,
                        path: requestPath,
                        status: statusCode,
                        strategy: displayStrategy,
                        duration,
                        cache: cacheStatus
                    })
                )
            } else {
                // Text log with emojis
                const statusEmoji =
                    statusCode >= 500 ? '❌' : statusCode >= 400 ? '⚠️' : statusCode >= 300 ? '↩️' : '✅'
                const timestamp = new Date().toISOString()
                logger.info(
                    `${timestamp} ${statusEmoji} ${req.method} ${hostname}${requestPath} | ${statusCode} | ${displayStrategy} | ${duration}ms`
                )
            }
        }

        return originalEnd(chunk, encoding)
    }

    next()
})

// Health check endpoint
app.get('/health', async (_req: Request, res: Response) => {
    const config = getEffectiveConfig()
    const queueStats = getQueueStats()
    const health: {
        status: string
        activeRenders: number
        parallelRenders: number
        queueDepth: number
        hosts: number
        browser?: { available: boolean; error?: string }
        cache?: { writable: boolean; error?: string }
    } = {
        status: 'ok',
        activeRenders: queueStats.activeRenders,
        parallelRenders: config.parallelRenders,
        queueDepth: queueStats.queueDepth,
        hosts: globalConfig.hosts.length
    }

    health.browser = { available: isBrowserReady() }

    try {
        const cacheDir = process.env.CACHE_DIR || '.cache'
        const cachePath = path.isAbsolute(cacheDir) ? cacheDir : path.join(process.cwd(), cacheDir)
        await fs.promises.access(cachePath, fs.constants.W_OK).catch(() => {
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

const isFilePath = (filePath: string): boolean => {
    // Decode first so an encoded extension is still recognised as an asset request.
    // A malformed path falls back to the raw value; validatePath rejects it later.
    const decodedPath = decodeRequestPath(filePath) ?? filePath

    const ext = path.extname(decodedPath)
    return ext !== '' && ext !== '/'
}

// Content-hash pattern: a separator (.|-) followed by an 8+ char token that
// contains at least one digit, then the extension. Matches webpack-style
// (main.1a2b3c4d.js) and Vite-style (index-Dea4n0lr.js) hashed assets while
// excluding non-hashed names like app.production.js or styles.responsive.css.
const CONTENT_HASH_PATTERN = /[.-](?=[A-Za-z0-9_-]{8,}\.)[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\.\w+$/

const sendStaticFile = (res: Response, filePath: string): void => {
    const ext = path.extname(filePath).toLowerCase()

    if (ext === '.html' || ext === '.htm') {
        res.setHeader('Cache-Control', 'no-cache')
    } else if (CONTENT_HASH_PATTERN.test(path.basename(filePath))) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    }

    res.sendFile(filePath)
}

const shouldRender = (
    effectiveConfig: Pick<ReturnType<typeof getEffectiveConfig>, 'ssr' | 'ssrExclude'>,
    requestPath: string,
    isInternalRender: boolean
): boolean => {
    // The render browser loads pages from this same server; rendering its own
    // sub-requests again would recurse until the queue drowns
    if (isInternalRender) return false

    // Routes listed in ssrExclude stay pure CSR — index.html is served untouched
    if (isSsrExcludedPath(effectiveConfig.ssrExclude, requestPath)) return false

    return effectiveConfig.ssr
}

// Track index.html mtime per source directory to auto-invalidate SSR cache on deploy
const indexMtimeMap = new Map<string, number>()

const invalidateCacheIfSourceChanged = async (sourcePath: string): Promise<void> => {
    const indexPath = path.join(sourcePath, 'index.html')
    try {
        const stats = fs.statSync(indexPath)
        const currentMtime = stats.mtimeMs
        const lastMtime = indexMtimeMap.get(sourcePath)

        if (lastMtime !== undefined && lastMtime !== currentMtime) {
            logger.info(`Source changed: ${sourcePath}/index.html — clearing SSR cache`)
            await cache.clear()
        }

        indexMtimeMap.set(sourcePath, currentMtime)
    } catch {
        // index.html doesn't exist or can't be read — skip
    }
}

// In-memory dedup set for background refresh
const refreshInFlight = new Set<string>()

/**
 * Triggers an async background re-render and updates the cache.
 * Deduplicates by deviceType:url key. Enqueued at low priority via render queue.
 */
const triggerBackgroundRefresh = (
    cacheKey: string,
    localUrl: string,
    origin: string | undefined,
    deviceType: string,
    effectiveConfig: ReturnType<typeof getEffectiveConfig>
): void => {
    const dedupeKey = `${deviceType}:${cacheKey}`
    if (refreshInFlight.has(dedupeKey)) return

    refreshInFlight.add(dedupeKey)
    logger.info(`SSR-REFRESH triggered for ${cacheKey}`)

    // Enqueue at low priority so real requests take precedence
    enqueue('low', async () => {
        try {
            const html = await render(
                localUrl,
                {
                    timeoutMs: effectiveConfig.timeoutMs,
                    parallelRenders: effectiveConfig.parallelRenders,
                    rootSelector: effectiveConfig.rootSelector
                },
                RENDERX_USER_AGENT,
                origin
            )

            if (html) {
                await cache.set(cacheKey, html, deviceType, effectiveConfig.cacheTtl)
            }
        } catch (err) {
            logger.warn('Background refresh failed:', err)
        } finally {
            refreshInFlight.delete(dedupeKey)
        }
    }).catch(() => {
        refreshInFlight.delete(dedupeKey)
    })
}

/**
 * Renders a page (or serves from cache) and sends the response.
 * Supports stale-while-revalidate: stale cache is served instantly with a background refresh.
 */
const renderPage = async (
    res: Response,
    cacheKey: string,
    localUrl: string,
    origin: string | undefined,
    effectiveConfig: ReturnType<typeof getEffectiveConfig>,
    signal?: AbortSignal
): Promise<boolean> => {
    const cached = await cache.get(cacheKey, 'desktop', effectiveConfig.cacheTtl)

    if (cached) {
        ;(res as Response & { _cacheHit?: boolean })._cacheHit = true
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache')
        res.send(cached.html)

        if (cached.stale) {
            triggerBackgroundRefresh(cacheKey, localUrl, origin, 'desktop', effectiveConfig)
        }

        return true
    }

    try {
        const html = await enqueue('high', () =>
            render(
                localUrl,
                {
                    timeoutMs: effectiveConfig.timeoutMs,
                    parallelRenders: effectiveConfig.parallelRenders,
                    rootSelector: effectiveConfig.rootSelector
                },
                RENDERX_USER_AGENT,
                origin,
                signal
            )
        )

        if (html) {
            const isErrorPage = html.length < 500 && html.includes('"error"')
            if (isErrorPage) {
                logger.warn(`SSR produced error page for ${cacheKey} (${html.length} bytes), skipping cache`)
                return false
            }
            await cache.set(cacheKey, html, 'desktop', effectiveConfig.cacheTtl)
            ;(res as Response & { _cacheHit?: boolean })._cacheHit = false
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.setHeader('Cache-Control', 'no-cache')
            res.send(html)
            return true
        }
    } catch (err) {
        const error = err as Error
        if (error.message.includes('Render aborted')) return false
        if (error.message.includes('render queue full')) {
            sendError(res, 503, 'Service temporarily unavailable', 'Server at capacity, try again later')
            return true
        }
        logger.error('Render error:', err)
    }

    return false
}

// /render endpoint — open, protected by rate limiter
app.get('/render', async (req: Request, res: Response) => {
    try {
        const url = req.query.url as string | undefined

        if (!url) {
            return sendError(res, 400, 'Missing required parameter: url')
        }

        let parsedUrl: URL
        try {
            parsedUrl = new URL(url)
        } catch {
            return sendError(res, 400, 'Invalid URL format')
        }

        if (!isSafeUrl(parsedUrl)) {
            return sendError(res, 400, 'Invalid URL', 'Internal/localhost URLs are not allowed')
        }

        const hostname = parsedUrl.hostname
        const effectiveConfig = getEffectiveConfig(hostname)
        const deviceType = (req.query.device as string | undefined) || 'desktop'

        const cached = await cache.get(url, deviceType, effectiveConfig.cacheTtl)
        if (cached) {
            res.set('X-Cache', cached.stale ? 'STALE' : 'HIT')
            res.setHeader('Content-Type', 'text/html; charset=utf-8')

            if (cached.stale) {
                const localUrl = `http://localhost:${globalConfig.port}${parsedUrl.pathname}${parsedUrl.search}`
                const origin = `${parsedUrl.protocol}//${parsedUrl.host}`
                triggerBackgroundRefresh(url, localUrl, origin, deviceType, effectiveConfig)
            }

            return res.send(cached.html)
        }

        const localUrl = `http://localhost:${globalConfig.port}${parsedUrl.pathname}${parsedUrl.search}`
        const origin = `${parsedUrl.protocol}//${parsedUrl.host}`
        const signal = (res as Response & { renderAbortSignal?: AbortSignal }).renderAbortSignal

        const html = await enqueue('high', () =>
            render(
                localUrl,
                {
                    timeoutMs: effectiveConfig.timeoutMs,
                    parallelRenders: effectiveConfig.parallelRenders,
                    rootSelector: effectiveConfig.rootSelector
                },
                'RenderX/1.0',
                origin,
                signal
            )
        )

        if (!html) {
            return sendError(res, 500, 'Failed to render page')
        }

        await cache.set(url, html, deviceType, effectiveConfig.cacheTtl)
        res.set('X-Cache', 'MISS')
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.send(html)
    } catch (err) {
        const error = err as Error

        if (error.message.includes('render queue full')) {
            return sendError(res, 503, 'Service temporarily unavailable', 'Server at capacity, try again later')
        }

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

    try {
        new URL(url)
    } catch {
        return sendError(res, 400, 'Invalid URL format')
    }

    const validDevices = ['desktop', 'mobile', 'tablet']
    const deviceType = device && validDevices.includes(device) ? device : 'desktop'

    const result = await cache.invalidate(url, deviceType)
    return res.json({ success: result })
})

app.post('/cache/clear', async (_req: Request, res: Response) => {
    const result = await cache.clear()
    return res.json({ success: result })
})

// Main routing middleware
app.use(async (req: Request, res: Response, next: () => void) => {
    // Reject known scanner/bot probes early
    if (isScannerPath(req.path)) {
        return sendError(res, 403, 'Forbidden')
    }

    const origin = req.headers.origin
    const isInternalRender = req.headers['x-renderx-internal'] === INTERNAL_RENDER_TOKEN
    const isFileRequest = isFilePath(req.path)

    // Internal render requests: serve files/assets directly
    if (isInternalRender) {
        let targetHostConfig: HostConfig | null = null

        if (origin) {
            try {
                const originUrl = new URL(origin)
                const originHostname = originUrl.hostname
                targetHostConfig = getHostConfig(originHostname)
            } catch {
                // Invalid origin format
            }
        }

        if (!targetHostConfig) {
            const hostname = req.headers.host?.split(':')[0] || ''
            if (hostname) {
                targetHostConfig = getHostConfig(hostname)
            }
        }

        if (targetHostConfig && targetHostConfig.isActive !== false) {
            const sourcePath = path.join(process.cwd(), './hosts', targetHostConfig.source)
            const validatedFilePath = validatePath(sourcePath, req.path)

            if (validatedFilePath && fs.existsSync(validatedFilePath)) {
                const stats = fs.statSync(validatedFilePath)
                if (stats.isFile()) {
                    return sendStaticFile(res, validatedFilePath)
                }
                if (stats.isDirectory()) {
                    const indexPath = path.join(validatedFilePath, 'index.html')
                    if (fs.existsSync(indexPath)) {
                        return sendStaticFile(res, indexPath)
                    }
                }
            }

            if (!isFileRequest) {
                const indexPath = path.join(sourcePath, 'index.html')
                if (fs.existsSync(indexPath)) {
                    return sendStaticFile(res, indexPath)
                }
            }
        }

        return sendError(res, 404, 'Not found')
    }

    // Parse origin hostname
    let originHostname: string

    if (origin) {
        try {
            const originUrl = new URL(origin)
            originHostname = originUrl.hostname

            if (!isValidOrigin(origin)) {
                return sendError(res, 403, 'Invalid origin', 'Origin does not match any configured host')
            }
        } catch {
            return sendError(res, 400, 'Invalid Origin header format')
        }
    } else {
        originHostname = req.headers.host?.split(':')[0] || ''
        if (!originHostname) {
            return sendError(res, 400, 'Unable to determine hostname')
        }
    }

    const hostConfig = getHostConfig(originHostname)

    if (!hostConfig) {
        if (!origin) {
            return sendError(res, 403, 'Invalid host', 'Host does not match any configured host')
        }
        return next()
    }

    if (hostConfig.isActive === false) {
        return sendError(res, 503, 'Host is not active')
    }

    const effectiveConfig = getEffectiveConfig(originHostname)

    // Serve static files from source directory
    const sourcePath = path.join(process.cwd(), effectiveConfig.hostsDir, hostConfig.source)

    // Handle root path
    if (req.path === '/') {
        const indexPath = path.join(sourcePath, 'index.html')

        if (fs.existsSync(indexPath)) {
            if (shouldRender(effectiveConfig, req.path, isInternalRender)) {
                await invalidateCacheIfSourceChanged(sourcePath)
                const cacheKey = origin
                    ? `${origin}${req.originalUrl}`
                    : `${req.protocol}://${originHostname}${req.originalUrl}`

                const localUrl = `http://localhost:${globalConfig.port}${req.originalUrl}`
                const signal = (res as Response & { renderAbortSignal?: AbortSignal }).renderAbortSignal

                const effectiveOrigin = origin || `http://${originHostname}`
                const rendered = await renderPage(res, cacheKey, localUrl, effectiveOrigin, effectiveConfig, signal)
                if (rendered) return
            }
            return sendStaticFile(res, indexPath)
        }
        return sendError(res, 404, 'Not found', `index.html not found in source directory: ${sourcePath}`)
    }

    // Check for direct file
    const validatedFilePath = validatePath(sourcePath, req.path)
    if (validatedFilePath && fs.existsSync(validatedFilePath)) {
        if (fs.statSync(validatedFilePath).isFile()) {
            return sendStaticFile(res, validatedFilePath)
        }

        if (fs.statSync(validatedFilePath).isDirectory()) {
            const indexPath = path.join(validatedFilePath, 'index.html')
            if (fs.existsSync(indexPath)) {
                return sendStaticFile(res, indexPath)
            }
        }
    }

    // A request that names a file and matched none is a miss. Serving the SPA shell here
    // would answer 200 for every mistyped asset and every absent robots.txt.
    if (isFileRequest) {
        return sendError(res, 404, 'Not found')
    }

    // SPA routes: serve index.html (with optional SSR)
    const indexPath = path.join(sourcePath, 'index.html')
    if (fs.existsSync(indexPath)) {
        if (shouldRender(effectiveConfig, req.path, isInternalRender)) {
            await invalidateCacheIfSourceChanged(sourcePath)
            const cacheKey = origin
                ? `${origin}${req.originalUrl}`
                : `${req.protocol}://${originHostname}${req.originalUrl}`

            const localUrl = `http://localhost:${globalConfig.port}${req.originalUrl}`
            const signal = (res as Response & { renderAbortSignal?: AbortSignal }).renderAbortSignal

            const effectiveOrigin = origin || `http://${originHostname}`
            const rendered = await renderPage(res, cacheKey, localUrl, effectiveOrigin, effectiveConfig, signal)
            if (rendered) return
        }

        return sendStaticFile(res, indexPath)
    }

    return sendError(res, 404, 'Not found')
})

// Start server
const PORT = globalConfig.port
app.listen(PORT, () => {
    console.log(`RenderX server listening on port ${PORT}`)
    console.log(`Configuration:`)
    console.log(`  Hosts: ${globalConfig.hosts.length}`)
    console.log(`  SSR: ${globalConfig.ssr ? 'enabled' : 'disabled'}`)
    console.log(`  Parallel Renders: ${globalConfig.parallelRenders}`)
    const cacheCleanupInterval = globalConfig.cacheCleanupInterval || 60
    console.log(`  Cache Cleanup Interval: ${cacheCleanupInterval} minutes`)
    console.log(`  Cache Directory: ${process.env.CACHE_DIR || '.cache'}`)
    console.log(`  Hosts Directory: ./hosts`)
    console.log(`  Log Format: ${globalConfig.logFormat}`)
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
