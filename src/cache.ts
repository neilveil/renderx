import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { logger } from './logger'

// Constants
const DEFAULT_CACHE_TTL_SECONDS = 3600
const CACHE_CLEANUP_BATCH_SIZE = 100

const getCacheDir = (): string => {
    // Use environment variable if set, otherwise default to .cache
    const cacheDir = process.env.CACHE_DIR || '.cache'
    // If relative path, resolve relative to process.cwd()
    return path.isAbsolute(cacheDir) ? cacheDir : path.join(process.cwd(), cacheDir)
}

// Cache directory initialization state
let cacheDirInitialized = false
let cacheDirPromise: Promise<void> | null = null

/**
 * Ensures cache directory exists, using a promise-based lock to prevent race conditions.
 * @returns Promise that resolves when directory is ready
 */
const ensureCacheDir = async (): Promise<void> => {
    if (cacheDirInitialized) return

    if (cacheDirPromise) {
        return cacheDirPromise
    }

    cacheDirPromise = (async () => {
        try {
            const cacheDir = getCacheDir()
            await fs.mkdir(cacheDir, { recursive: true })
            cacheDirInitialized = true
        } catch (err) {
            const error = err as Error & { code?: string }
            logger.error('Failed to create cache directory:', err)
            // Reset promise on error so it can be retried
            cacheDirPromise = null
            throw error
        }
    })()

    return cacheDirPromise
}

// Initialize cache directory on module load (non-blocking)
ensureCacheDir().catch(() => {
    // Error already logged in ensureCacheDir
})

// Start automatic cleanup on module load
let cleanupInterval: NodeJS.Timeout | null = null

export const startCleanupInterval = async (intervalMinutes: number = 60, clearOnStartup: boolean = true): Promise<void> => {
    // Clear existing interval if any
    if (cleanupInterval) {
        clearInterval(cleanupInterval)
    }

    // Ensure cache directory exists first
    await ensureCacheDir()

    // Clear cache on startup if configured (default: true for fresh start)
    if (clearOnStartup) {
        try {
            const cacheDir = getCacheDir()
            const files = await fs.readdir(cacheDir).catch(() => [])
            const cacheFiles = files.filter((f: string) => f.endsWith('.html') || f.endsWith('.meta'))

            if (cacheFiles.length > 0) {
                await Promise.all(cacheFiles.map((file: string) => fs.unlink(path.join(cacheDir, file)).catch(() => {})))
                logger.info(`Cache directory cleared on startup: ${cacheFiles.length} files removed`)
            }
        } catch (err) {
            logger.error('Error clearing cache on startup:', err)
        }
    } else {
        // Only clear expired entries on startup
        try {
            await cache.cleanup()
        } catch (err) {
            logger.error('Error cleaning expired cache on startup:', err)
        }
    }

    // Convert minutes to milliseconds for setInterval
    const intervalMs = intervalMinutes * 60 * 1000

    // Set up periodic cleanup for expired entries
    cleanupInterval = setInterval(() => {
        cache.cleanup().catch(err => {
            logger.error('Periodic cache cleanup error:', err)
        })
    }, intervalMs)

    logger.info(`Cache cleanup scheduled: every ${intervalMinutes} minutes`)
}

export const stopCleanupInterval = (): void => {
    if (cleanupInterval) {
        clearInterval(cleanupInterval)
        cleanupInterval = null
        logger.info('Cache cleanup interval stopped')
    }
}

const getCacheKey = (url: string, deviceType: string = 'desktop'): string => {
    // Use SHA-256 for cache keys (more future-proof than MD5)
    const hash = createHash('sha256').update(`${deviceType}:${url}`).digest('hex')
    return path.join(getCacheDir(), `${hash}.html`)
}

const getMetadataPath = (cacheKey: string): string => {
    return `${cacheKey}.meta`
}

interface CacheMetadata {
    expiresAt: number
    url: string
    deviceType: string
}

const isExpired = (metadata: CacheMetadata): boolean => {
    return Date.now() > metadata.expiresAt
}

export interface CacheInterface {
    get(url: string, deviceType?: string): Promise<string | null>
    set(url: string, html: string, deviceType?: string, cacheTtl?: number): Promise<boolean>
    invalidate(url: string, deviceType?: string): Promise<boolean>
    clear(): Promise<boolean>
    cleanup(): Promise<{ removed: number; errors: number }>
}

const cache: CacheInterface = {
    async get(url: string, deviceType: string = 'desktop'): Promise<string | null> {
        try {
            // Ensure cache directory exists
            await ensureCacheDir()

            const cacheKey = getCacheKey(url, deviceType)
            const metadataPath = getMetadataPath(cacheKey)

            // Check if metadata exists
            let metadata: CacheMetadata
            try {
                const metadataContent = await fs.readFile(metadataPath, 'utf-8')
                metadata = JSON.parse(metadataContent)
            } catch (err) {
                const error = err as Error & { code?: string }
                // File doesn't exist - cache miss (not an error)
                if (error.code === 'ENOENT') {
                    return null
                }
                // Other errors (permission, corruption, etc.) - log but return null
                logger.warn('Cache metadata read error (treating as cache miss):', error.message)
                return null
            }

            // Check if expired
            if (isExpired(metadata)) {
                // Clean up expired files
                try {
                    await Promise.all([fs.unlink(cacheKey).catch(() => {}), fs.unlink(metadataPath).catch(() => {})])
                } catch {
                    // Ignore errors if files don't exist
                }
                return null
            }

            // Read cached HTML
            try {
                const html = await fs.readFile(cacheKey, 'utf-8')
                return html
            } catch (err) {
                const error = err as Error & { code?: string }
                if (error.code === 'ENOENT') {
                    // HTML file missing but metadata exists - inconsistent state, clean up
                    logger.warn('Cache HTML file missing, cleaning up metadata')
                    await fs.unlink(metadataPath).catch(() => {})
                    return null
                }
                // Other errors (permission, corruption, etc.)
                logger.error('Cache HTML read error:', err)
                return null
            }
        } catch (err) {
            logger.error('Cache get error:', err)
            return null
        }
    },

    async set(
        url: string,
        html: string,
        deviceType: string = 'desktop',
        cacheTtl: number = DEFAULT_CACHE_TTL_SECONDS
    ): Promise<boolean> {
        try {
            await ensureCacheDir()

            const cacheKey = getCacheKey(url, deviceType)
            const metadataPath = getMetadataPath(cacheKey)

            const expiresAt = Date.now() + cacheTtl * 1000
            const metadata: CacheMetadata = {
                expiresAt,
                url,
                deviceType
            }

            // Write HTML and metadata atomically
            await Promise.all([
                fs.writeFile(cacheKey, html, 'utf-8'),
                fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf-8')
            ])

            return true
        } catch (err) {
            logger.error('Cache set error:', err)
            return false
        }
    },

    async invalidate(url: string, deviceType: string = 'desktop'): Promise<boolean> {
        try {
            const cacheKey = getCacheKey(url, deviceType)
            const metadataPath = getMetadataPath(cacheKey)

            await Promise.all([fs.unlink(cacheKey).catch(() => {}), fs.unlink(metadataPath).catch(() => {})])

            return true
        } catch (err) {
            logger.error('Cache invalidate error:', err)
            return false
        }
    },

    async clear(): Promise<boolean> {
        try {
            const cacheDir = getCacheDir()
            const files = await fs.readdir(cacheDir)
            const cacheFiles = files.filter((f: string) => f.endsWith('.html') || f.endsWith('.meta'))

            await Promise.all(cacheFiles.map((file: string) => fs.unlink(path.join(cacheDir, file)).catch(() => {})))

            logger.info(`Cache cleared: ${cacheFiles.length} files removed`)
            return true
        } catch (err) {
            logger.error('Cache clear error:', err)
            return false
        }
    },

    async cleanup(): Promise<{ removed: number; errors: number }> {
        let removed = 0
        let errors = 0

        try {
            await ensureCacheDir()
            const cacheDir = getCacheDir()
            const files = await fs.readdir(cacheDir)
            const metaFiles = files.filter((f: string) => f.endsWith('.meta'))

            // Process metadata files in batches for better performance
            const processFile = async (metaFile: string): Promise<void> => {
                try {
                    const metaPath = path.join(cacheDir, metaFile)
                    const metaContent = await fs.readFile(metaPath, 'utf-8')
                    const metadata: CacheMetadata = JSON.parse(metaContent)

                    // Check if expired
                    if (isExpired(metadata)) {
                        // Remove both metadata and HTML files
                        const htmlFile = metaFile.replace('.meta', '')
                        const htmlPath = path.join(cacheDir, htmlFile)

                        await Promise.all([fs.unlink(metaPath).catch(() => {}), fs.unlink(htmlPath).catch(() => {})])

                        removed++
                    }
                } catch (err) {
                    errors++
                }
            }

            // Process in batches to avoid overwhelming the system
            for (let i = 0; i < metaFiles.length; i += CACHE_CLEANUP_BATCH_SIZE) {
                const batch = metaFiles.slice(i, i + CACHE_CLEANUP_BATCH_SIZE)
                await Promise.all(batch.map(processFile))
            }

            if (removed > 0 || errors > 0) {
                logger.info(`Cache cleanup completed: ${removed} expired entries removed, ${errors} errors`)
            }

            return { removed, errors }
        } catch (err) {
            logger.error('Cache cleanup error:', err)
            return { removed, errors: errors + 1 }
        }
    }
}

export default cache
