import { randomUUID } from 'crypto'
import express, { NextFunction, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import cache, { startCleanupInterval, stopCleanupInterval } from './cache'
import { getConfig, getEffectiveConfig, getHostConfig, HostConfig } from './config'
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
    const relativePath = requestedPath.startsWith('/') ? requestedPath.slice(1) : requestedPath
    const normalizedPath = path.normalize(relativePath)

    if (normalizedPath.includes('..') || path.isAbsolute(normalizedPath)) {
        return null
    }

    const resolvedPath = path.resolve(basePath, normalizedPath)
    const resolvedBase = path.resolve(basePath)

    if (!resolvedPath.startsWith(resolvedBase)) {
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

// Request timeout middleware
app.use((_req: Request, res: Response, next: NextFunction) => {
    const timeout = setTimeout(() => {
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
    const userAgent = req.headers['user-agent'] || ''
    const isRenderXRequest = userAgent.toLowerCase().includes('renderx')
    const isInternalRender = req.headers['x-renderx-internal'] === 'true'
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
        if (isInternalRender || isRenderXRequest || isFileRequest || managementPaths.includes(req.path)) {
            strategy = 'static'
        } else {
            const effectiveConfig = getEffectiveConfig(hostname)
            strategy = effectiveConfig.ssr ? 'ssr' : 'static'
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
    const ext = path.extname(filePath)
    return ext !== '' && ext !== '/'
}

const shouldRender = (
    ssrEnabled: boolean,
    isRenderXRequest: boolean,
    isDirectFile: boolean,
    isInternalRender: boolean = false
): boolean => {
    if (isInternalRender) return false
    if (isRenderXRequest) return false
    if (isDirectFile) return false

    return ssrEnabled
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
    effectiveConfig: ReturnType<typeof getEffectiveConfig>
): Promise<boolean> => {
    const cached = await cache.get(cacheKey, 'desktop', effectiveConfig.cacheTtl)

    if (cached) {
        ;(res as Response & { _cacheHit?: boolean })._cacheHit = true
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.send(cached.html)

        // Background refresh if stale
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
                origin
            )
        )

        if (html) {
            await cache.set(cacheKey, html, 'desktop', effectiveConfig.cacheTtl)
            ;(res as Response & { _cacheHit?: boolean })._cacheHit = false
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.send(html)
            return true
        }
    } catch (err) {
        const error = err as Error
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

        const html = await enqueue('high', () =>
            render(
                localUrl,
                {
                    timeoutMs: effectiveConfig.timeoutMs,
                    parallelRenders: effectiveConfig.parallelRenders,
                    rootSelector: effectiveConfig.rootSelector
                },
                'RenderX/1.0',
                origin
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
    const origin = req.headers.origin
    const userAgent = req.headers['user-agent'] || ''
    const isRenderXRequest = userAgent.toLowerCase().includes('renderx')
    const isInternalRender = req.headers['x-renderx-internal'] === 'true'
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
                    return res.sendFile(validatedFilePath)
                }
                if (stats.isDirectory()) {
                    const indexPath = path.join(validatedFilePath, 'index.html')
                    if (fs.existsSync(indexPath)) {
                        return res.sendFile(indexPath)
                    }
                }
            }

            if (!isFileRequest) {
                const indexPath = path.join(sourcePath, 'index.html')
                if (fs.existsSync(indexPath)) {
                    return res.sendFile(indexPath)
                }
            }
        }

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
                if (stats.isDirectory()) {
                    const indexPath = path.join(validatedFilePath, 'index.html')
                    if (fs.existsSync(indexPath)) {
                        return res.sendFile(indexPath)
                    }
                }
            }
        }

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

    // Serve files without origin from any host
    if (isFileRequest && !origin) {
        for (const hostConfig of globalConfig.hosts) {
            if (hostConfig.isActive === false) continue

            const sourcePath = path.join(process.cwd(), './hosts', hostConfig.source)
            const validatedFilePath = validatePath(sourcePath, req.path)

            if (validatedFilePath && fs.existsSync(validatedFilePath) && fs.statSync(validatedFilePath).isFile()) {
                return res.sendFile(validatedFilePath)
            }
        }
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
            if (shouldRender(effectiveConfig.ssr, isRenderXRequest, false, isInternalRender)) {
                const cacheKey = origin
                    ? `${origin}${req.originalUrl}`
                    : `${req.protocol}://${originHostname}${req.originalUrl}`

                const localUrl = `http://localhost:${globalConfig.port}${req.originalUrl}`

                const rendered = await renderPage(res, cacheKey, localUrl, origin || undefined, effectiveConfig)
                if (rendered) return
            }
            return res.sendFile(indexPath)
        }
        return sendError(res, 404, 'Not found', `index.html not found in source directory: ${sourcePath}`)
    }

    // Check for direct file
    const validatedFilePath = validatePath(sourcePath, req.path)
    if (validatedFilePath && fs.existsSync(validatedFilePath)) {
        if (fs.statSync(validatedFilePath).isFile()) {
            return res.sendFile(validatedFilePath)
        }

        if (fs.statSync(validatedFilePath).isDirectory()) {
            const indexPath = path.join(validatedFilePath, 'index.html')
            if (fs.existsSync(indexPath)) {
                return res.sendFile(indexPath)
            }
        }
    }

    // SPA routes: serve index.html (with optional SSR)
    const indexPath = path.join(sourcePath, 'index.html')
    if (fs.existsSync(indexPath)) {
        const isDirectFile = isFilePath(req.path)
        if (shouldRender(effectiveConfig.ssr, isRenderXRequest, isDirectFile, isInternalRender)) {
            const cacheKey = origin
                ? `${origin}${req.originalUrl}`
                : `${req.protocol}://${originHostname}${req.originalUrl}`

            const localUrl = `http://localhost:${globalConfig.port}${req.originalUrl}`

            const rendered = await renderPage(res, cacheKey, localUrl, origin || undefined, effectiveConfig)
            if (rendered) return
        }

        return res.sendFile(indexPath)
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
