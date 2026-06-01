import { Browser, BrowserContext } from 'playwright'
import { logger } from './logger'

const MAX_RENDERS_PER_CONTEXT = 50
const MAX_AGE_MS = 10 * 60 * 1000
const STUCK_CONTEXT_TIMEOUT_MS = 60 * 1000

type PoolEntry = {
    context: BrowserContext
    inUse: boolean
    createdAt: number
    renderCount: number
    acquiredAt: number | null
}

let pool: PoolEntry[] = []
let browserRef: Browser | null = null
let sweepInterval: ReturnType<typeof setInterval> | null = null

/**
 * Creates a single browser context with shared viewport/permission config.
 * Per-request userAgent and Origin are set via route interception, so the
 * context itself uses a generic UA.
 */
const createContext = async (browser: Browser): Promise<BrowserContext> => {
    return browser.newContext({
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        permissions: [],
        javaScriptEnabled: true,
        acceptDownloads: false
    })
}

/**
 * Initializes the context pool with `size` pre-warmed browser contexts.
 * Called once during server startup from preLaunchBrowser().
 */
let initialized = false

export const initPool = async (browser: Browser, size: number): Promise<void> => {
    if (initialized) return

    browserRef = browser

    const entries = await Promise.all(
        Array.from({ length: size }, async () => {
            const context = await createContext(browser)
            return { context, inUse: false, createdAt: Date.now(), renderCount: 0, acquiredAt: null } satisfies PoolEntry
        })
    )

    pool = entries
    initialized = true
    startSweep()
    logger.info(`Context pool initialized: ${size} contexts`)
}

/**
 * Acquires an idle context from the pool. Blocks briefly if none available.
 * Recycles stale contexts (>50 renders or >10 min) transparently.
 */
export const acquire = async (): Promise<BrowserContext> => {
    const entry = pool.find(item => !item.inUse)
    if (!entry) {
        throw new Error('No available context in pool')
    }

    // Recycle if the context is old or heavily used
    const needsRecycle =
        entry.renderCount >= MAX_RENDERS_PER_CONTEXT || Date.now() - entry.createdAt > MAX_AGE_MS

    if (needsRecycle && browserRef) {
        try {
            await entry.context.close()
        } catch {
            // context may already be dead
        }
        entry.context = await createContext(browserRef)
        entry.createdAt = Date.now()
        entry.renderCount = 0
    }

    entry.inUse = true
    entry.acquiredAt = Date.now()
    entry.renderCount++
    return entry.context
}

/**
 * Returns a context to the pool. Resets by navigating all pages to about:blank.
 * If reset fails (crashed context), replaces with a fresh one.
 */
export const release = async (context: BrowserContext): Promise<void> => {
    const entry = pool.find(item => item.context === context)
    if (!entry) return

    try {
        const pages = context.pages()
        await Promise.all(pages.map(page => page.goto('about:blank').catch(() => {})))
    } catch {
        // Context crashed — replace it
        if (browserRef) {
            try {
                entry.context = await createContext(browserRef)
                entry.createdAt = Date.now()
                entry.renderCount = 0
            } catch (err) {
                logger.error('Failed to replace crashed context:', err)
            }
        }
    }

    entry.inUse = false
    entry.acquiredAt = null
}

/**
 * Periodically reclaims contexts stuck in `inUse` for longer than STUCK_CONTEXT_TIMEOUT_MS.
 * Prevents a single hung render from permanently consuming a pool slot.
 */
const startSweep = (): void => {
    if (sweepInterval) return
    sweepInterval = setInterval(async () => {
        const now = Date.now()
        for (const entry of pool) {
            if (!entry.inUse || !entry.acquiredAt) continue
            if (now - entry.acquiredAt < STUCK_CONTEXT_TIMEOUT_MS) continue

            logger.warn(`Force-reclaiming stuck context (held for ${now - entry.acquiredAt}ms)`)
            try {
                const pages = entry.context.pages()
                await Promise.all(pages.map(p => p.close().catch(() => {})))
            } catch {}

            if (browserRef) {
                try {
                    await entry.context.close()
                    entry.context = await createContext(browserRef)
                    entry.createdAt = Date.now()
                    entry.renderCount = 0
                } catch (err) {
                    logger.error('Failed to replace stuck context:', err)
                }
            }

            entry.inUse = false
            entry.acquiredAt = null
        }
    }, 30000)
}

/**
 * Destroys all contexts in the pool. Called during graceful shutdown.
 */
export const destroyPool = async (): Promise<void> => {
    await Promise.all(
        pool.map(async entry => {
            try {
                await entry.context.close()
            } catch {
                // ignore
            }
        })
    )
    if (sweepInterval) {
        clearInterval(sweepInterval)
        sweepInterval = null
    }
    pool = []
    browserRef = null
    initialized = false
    logger.info('Context pool destroyed')
}

