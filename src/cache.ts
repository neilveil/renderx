import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { getConfig } from './config'
import { logger } from './logger'

const DEFAULT_CACHE_TTL_SECONDS = 3600
const CACHE_CLEANUP_BATCH_SIZE = 100

const getCacheDir = (): string => {
    const cacheDir = process.env.CACHE_DIR || '.cache'
    return path.isAbsolute(cacheDir) ? cacheDir : path.join(process.cwd(), cacheDir)
}

let cacheDirInitialized = false
let cacheDirPromise: Promise<void> | null = null

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
            logger.error('Failed to create cache directory:', err)
            cacheDirPromise = null
            throw err
        }
    })()

    return cacheDirPromise
}

ensureCacheDir().catch(() => {})

let cleanupInterval: NodeJS.Timeout | null = null

export const startCleanupInterval = async (
    intervalMinutes: number = 60,
    clearOnStartup: boolean = true
): Promise<void> => {
    if (cleanupInterval) {
        clearInterval(cleanupInterval)
    }

    await ensureCacheDir()

    if (clearOnStartup) {
        try {
            const cacheDir = getCacheDir()
            const files = await fs.readdir(cacheDir).catch(() => [])
            const cacheFiles = files.filter((fileName: string) => fileName.endsWith('.html') || fileName.endsWith('.meta'))

            if (cacheFiles.length > 0) {
                await Promise.all(
                    cacheFiles.map((file: string) => fs.unlink(path.join(cacheDir, file)).catch(() => {}))
                )
                logger.info(`Cache directory cleared on startup: ${cacheFiles.length} files removed`)
            }
        } catch (err) {
            logger.error('Error clearing cache on startup:', err)
        }
    } else {
        try {
            await cache.cleanup()
        } catch (err) {
            logger.error('Error cleaning expired cache on startup:', err)
        }
    }

    const intervalMs = intervalMinutes * 60 * 1000

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
    const hash = createHash('sha256').update(`${deviceType}:${url}`).digest('hex')
    return path.join(getCacheDir(), `${hash}.html`)
}

const getMetadataPath = (cacheKey: string): string => {
    return `${cacheKey}.meta`
}

type CacheMetadata = {
    expiresAt: number
    createdAt: number
    url: string
    deviceType: string
}

type CacheGetResult = { html: string; stale: boolean }

export type CacheInterface = {
    get(url: string, deviceType?: string, cacheTtl?: number): Promise<CacheGetResult | null>
    set(url: string, html: string, deviceType?: string, cacheTtl?: number): Promise<boolean>
    invalidate(url: string, deviceType?: string): Promise<boolean>
    clear(): Promise<boolean>
    cleanup(): Promise<{ removed: number; errors: number }>
}

const cache: CacheInterface = {
    async get(
        url: string,
        deviceType: string = 'desktop',
        cacheTtl: number = DEFAULT_CACHE_TTL_SECONDS
    ): Promise<CacheGetResult | null> {
        try {
            await ensureCacheDir()

            const cacheKey = getCacheKey(url, deviceType)
            const metadataPath = getMetadataPath(cacheKey)

            let metadata: CacheMetadata
            try {
                const metadataContent = await fs.readFile(metadataPath, 'utf-8')
                metadata = JSON.parse(metadataContent)
            } catch (err) {
                const error = err as Error & { code?: string }
                if (error.code === 'ENOENT') return null
                logger.warn('Cache metadata read error (treating as cache miss):', error.message)
                return null
            }

            // Derive createdAt for legacy entries that lack it
            const createdAt = metadata.createdAt ?? metadata.expiresAt - cacheTtl * 1000

            // 2x TTL hard expiry: don't serve anything older than 2 full cycles
            const age = Date.now() - createdAt
            if (age > 2 * cacheTtl * 1000) {
                try {
                    await Promise.all([
                        fs.unlink(cacheKey).catch(() => {}),
                        fs.unlink(metadataPath).catch(() => {})
                    ])
                } catch {
                    // ignore
                }
                return null
            }

            let html: string
            try {
                html = await fs.readFile(cacheKey, 'utf-8')
            } catch (err) {
                const error = err as Error & { code?: string }
                if (error.code === 'ENOENT') {
                    logger.warn('Cache HTML file missing, cleaning up metadata')
                    await fs.unlink(metadataPath).catch(() => {})
                    return null
                }
                logger.error('Cache HTML read error:', err)
                return null
            }

            // Stale threshold: half of cacheTtl
            const stale = age >= (cacheTtl * 1000) / 2

            return { html, stale }
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

            const now = Date.now()
            const metadata: CacheMetadata = {
                expiresAt: now + cacheTtl * 1000,
                createdAt: now,
                url,
                deviceType
            }

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
            const cacheFiles = files.filter((fileName: string) => fileName.endsWith('.html') || fileName.endsWith('.meta'))

            await Promise.all(
                cacheFiles.map((file: string) => fs.unlink(path.join(cacheDir, file)).catch(() => {}))
            )

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
            const metaFiles = files.filter((fileName: string) => fileName.endsWith('.meta'))

            // Read cacheTtl from global config
            const globalCfg = getConfig()
            const cacheTtlSeconds = (globalCfg.cacheCleanupInterval || 60) * 60

            const processFile = async (metaFile: string): Promise<void> => {
                try {
                    const metaPath = path.join(cacheDir, metaFile)
                    const metaContent = await fs.readFile(metaPath, 'utf-8')
                    const metadata: CacheMetadata = JSON.parse(metaContent)

                    const createdAt = metadata.createdAt ?? metadata.expiresAt - cacheTtlSeconds * 1000
                    const age = Date.now() - createdAt

                    // Remove entries older than 2x TTL
                    if (age > 2 * cacheTtlSeconds * 1000) {
                        const htmlFile = metaFile.replace('.meta', '')
                        const htmlPath = path.join(cacheDir, htmlFile)

                        await Promise.all([fs.unlink(metaPath).catch(() => {}), fs.unlink(htmlPath).catch(() => {})])

                        removed++
                    }
                } catch {
                    errors++
                }
            }

            for (let index = 0; index < metaFiles.length; index += CACHE_CLEANUP_BATCH_SIZE) {
                const batch = metaFiles.slice(index, index + CACHE_CLEANUP_BATCH_SIZE)
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
