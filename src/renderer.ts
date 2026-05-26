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
    const remainingTimeout = (): number => Math.max(1000, timeoutMs - (Date.now() - startTime))

    try {
        if (!alreadyNavigated) {
            await page.goto(url, {
                waitUntil: 'load',
                timeout: timeoutMs
            })
        } else {
            await page.waitForLoadState('load', { timeout: remainingTimeout() })
        }

        try {
            await page.waitForLoadState('networkidle', { timeout: Math.min(15000, remainingTimeout()) })
        } catch {
            // continue
        }

        const rootSelector = config.rootSelector || '#root'
        const rootSelectors = [rootSelector, '#app', '[data-reactroot]', 'body > *']
        let rendered = false

        for (const selector of rootSelectors) {
            try {
                await page.waitForSelector(`${selector} > *`, {
                    timeout: Math.max(15000, remainingTimeout()),
                    state: 'attached'
                })
                rendered = true
                break
            } catch {
                // try next
            }
        }

        if (!rendered) {
            try {
                await page.waitForFunction(
                    `() => {
                        const root = document.querySelector('${rootSelector}') || document.querySelector('#app') || document.body;
                        return root && (root.textContent || root.innerText || '').trim().length > 0;
                    }`,
                    {
                        timeout: Math.max(10000, remainingTimeout()),
                        polling: 100
                    }
                )
            } catch {
                // continue
            }
        }

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
 */
export const render = async (
    url: string,
    config: RenderConfig,
    userAgent: string | null = null,
    origin: string | null = null
): Promise<string> => {
    let context: BrowserContext | null = null
    let page: Page | null = null
    let cleanupCompleted = false

    try {
        await launchBrowser()

        // Acquire a pre-warmed context from the pool
        context = await acquire()

        page = await context.newPage()

        // Set per-request userAgent and Origin via route interception
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

                // Override user agent per request
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
        logger.error(`Render error for ${url}:`, error.message)
        throw err
    } finally {
        // Close page but release context back to pool (not close)
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
