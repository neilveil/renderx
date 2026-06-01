import { Browser, BrowserContext, chromium, Page } from 'playwright'
import { acquire, destroyPool, initPool, release } from './contextPool'
import { logger } from './logger'
import { getConfig } from './config'
import { initRenderQueue } from './renderQueue'

export type RenderConfig = {
    timeoutMs: number
    parallelRenders: number
    rootSelector?: string
}

const BROWSER_CLEANUP_TIMEOUT_MS = 5000

let browser: Browser | null = null
let browserLaunchPromise: Promise<Browser> | null = null

const launchBrowser = async (): Promise<Browser> => {
    if (browser) return browser

    if (browserLaunchPromise) {
        return browserLaunchPromise
    }

    browserLaunchPromise = (async () => {
        try {
            browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process'
                ]
            })

            browser.on('disconnected', () => {
                browser = null
                browserLaunchPromise = null
            })
            return browser
        } catch (err) {
            const error = err as Error
            browserLaunchPromise = null

            if (error.message.includes("Executable doesn't exist") || error.message.includes('playwright')) {
                logger.error('Playwright browsers are not installed!')
                logger.error('Please run: npx playwright install chromium')
                logger.error('Or run: npm install (which will run postinstall script)')
                throw new Error('Playwright browsers not installed. Run: npx playwright install chromium')
            }

            logger.error('Failed to launch browser:', err)
            throw err
        }
    })()

    return browserLaunchPromise
}

const waitForReadiness = async (
    page: Page,
    url: string,
    config: RenderConfig,
    alreadyNavigated: boolean = false
): Promise<void> => {
    const { timeoutMs } = config
    const startTime = Date.now()
    const remainingTimeout = (): number => Math.max(0, timeoutMs - (Date.now() - startTime))

    try {
        if (!alreadyNavigated) {
            await page.goto(url, {
                waitUntil: 'load',
                timeout: timeoutMs
            })
        } else {
            await page.waitForLoadState('load', { timeout: remainingTimeout() })
        }

        if (remainingTimeout() <= 0) return

        try {
            await page.waitForLoadState('networkidle', { timeout: Math.min(15000, remainingTimeout()) })
        } catch {
            // continue
        }

        if (remainingTimeout() <= 0) return

        const rootSelector = config.rootSelector || '#root'
        const rootSelectors = [rootSelector, '#app', '[data-reactroot]', 'body > *']
        let rendered = false

        for (const selector of rootSelectors) {
            if (remainingTimeout() <= 0) break
            try {
                await page.waitForSelector(`${selector} > *`, {
                    timeout: Math.min(15000, remainingTimeout()),
                    state: 'attached'
                })
                rendered = true
                break
            } catch {
                // try next
            }
        }

        if (!rendered && remainingTimeout() > 0) {
            try {
                await page.waitForFunction(
                    `() => {
                        const root = document.querySelector('${rootSelector}') || document.querySelector('#app') || document.body;
                        return root && (root.textContent || root.innerText || '').trim().length > 0;
                    }`,
                    {
                        timeout: Math.min(10000, remainingTimeout()),
                        polling: 100
                    }
                )
            } catch {
                // continue
            }
        }

        if (remainingTimeout() <= 0) return

        try {
            await page.waitForLoadState('networkidle', { timeout: Math.min(10000, remainingTimeout()) })
        } catch {
            // continue
        }
    } catch (err) {
        const error = err as Error
        if (!error.message.includes('timeout')) {
            throw err
        }
    }
}

/**
 * Renders a URL using Playwright with a pooled browser context.
 * Per-request userAgent and Origin are set via route interception on the page.
 * Accepts an optional AbortSignal to cancel the render externally (e.g. on Express timeout).
 */
export const render = async (
    url: string,
    config: RenderConfig,
    userAgent: string | null = null,
    origin: string | null = null,
    signal?: AbortSignal
): Promise<string> => {
    let context: BrowserContext | null = null
    let page: Page | null = null
    let cleanupCompleted = false
    let hardTimeoutId: ReturnType<typeof setTimeout> | null = null

    const forceClosePage = () => {
        if (page) page.close().catch(() => {})
    }

    const onAbort = () => forceClosePage()
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
        if (signal?.aborted) throw new Error('Render aborted')

        await launchBrowser()

        context = await acquire()

        page = await context.newPage()

        // Hard timeout: force-close the page if render exceeds 2x the configured timeout.
        // This prevents renders from running indefinitely even if waitForReadiness stages compound.
        const hardTimeoutMs = config.timeoutMs * 2
        hardTimeoutId = setTimeout(() => {
            logger.warn(`Hard render timeout (${hardTimeoutMs}ms) for ${url}, force-closing page`)
            forceClosePage()
        }, hardTimeoutMs)

        await page.route('**/*', route => {
            const request = route.request()
            const resourceType = request.resourceType()

            const allowedTypes = ['document', 'script', 'xhr', 'fetch']
            if (!allowedTypes.includes(resourceType)) {
                route.abort()
            } else {
                const headers: Record<string, string> = { ...request.headers() }
                if (origin) {
                    headers['Origin'] = origin
                }
                headers['X-RenderX-Internal'] = 'true'

                if (userAgent) {
                    headers['User-Agent'] = userAgent
                }

                route.continue({ headers })
            }
        })

        await waitForReadiness(page, url, config, false)

        const html = await page.content()
        return html
    } catch (err) {
        const error = err as Error
        if (signal?.aborted) {
            logger.warn(`Render aborted for ${url}`)
            throw new Error('Render aborted')
        }
        logger.error(`Render error for ${url}:`, error.message)
        throw err
    } finally {
        if (hardTimeoutId) clearTimeout(hardTimeoutId)
        signal?.removeEventListener('abort', onAbort)

        const cleanupPromise = (async () => {
            if (page) {
                try {
                    await page.close()
                } catch (err) {
                    logger.error('Error closing page:', err)
                }
            }
            if (context) {
                try {
                    await release(context)
                } catch (err) {
                    logger.error('Error releasing context:', err)
                }
            }
            cleanupCompleted = true
        })()

        const timeoutPromise = new Promise<void>(resolve => {
            setTimeout(() => {
                if (!cleanupCompleted) {
                    logger.warn('Browser cleanup timeout - forcing cleanup')
                    if (page) {
                        page.close().catch(() => {})
                    }
                    if (context) {
                        release(context).catch(() => {})
                    }
                }
                resolve()
            }, BROWSER_CLEANUP_TIMEOUT_MS)
        })

        await Promise.race([cleanupPromise, timeoutPromise])
    }
}

export const isBrowserReady = (): boolean => {
    return browser !== null && browser.isConnected()
}

/**
 * Pre-launches browser and initializes the context pool on startup.
 * Pool size matches parallelRenders from global config.
 */
export const preLaunchBrowser = async (): Promise<void> => {
    try {
        const browserInstance = await launchBrowser()
        const config = getConfig()

        // Init context pool and render queue with same parallelRenders limit
        await initPool(browserInstance, config.parallelRenders)
        initRenderQueue(config.parallelRenders)

        browserInstance.on('disconnected', () => {
            logger.warn('Browser disconnected, pool will be rebuilt on next launch')
        })
    } catch {
        // Don't fail server startup — browser will be retried on first render
    }
}

// Graceful shutdown: destroy pool then close browser
process.on('SIGTERM', async () => {
    await destroyPool()
    if (browser) {
        await browser.close()
    }
    process.exit(0)
})

process.on('SIGINT', async () => {
    await destroyPool()
    if (browser) {
        await browser.close()
    }
    process.exit(0)
})
