import { Browser, BrowserContext, chromium, Page } from 'playwright'
import { optimizeHtmlForSEO } from './htmlOptimizer'
import { logger } from './logger'

import { HtmlOptimizerOptions } from './htmlOptimizer'
import { RenderingStrategy } from './config'

export interface RenderConfig {
    timeoutMs: number
    maxConcurrency: number
    rootSelector?: string // Optional root selector for SPA detection (default: '#root')
    htmlOptimizerOptions?: HtmlOptimizerOptions // Optional HTML optimizer configuration
    strategy?: RenderingStrategy // Rendering strategy - if 'ssr', HTML optimization is skipped
}

// Constants
const DEFAULT_VIEWPORT_WIDTH = 1920
const DEFAULT_VIEWPORT_HEIGHT = 1080
const BROWSER_CLEANUP_TIMEOUT_MS = 5000

let browser: Browser | null = null
let browserLaunchPromise: Promise<Browser> | null = null
let activeRequests = 0

/**
 * Launches a browser instance, ensuring only one launch happens at a time.
 * Uses a promise-based lock to prevent race conditions.
 * @returns Promise resolving to the browser instance
 */
const launchBrowser = async (): Promise<Browser> => {
    if (browser) return browser

    // Use existing promise if launch is already in progress
    if (browserLaunchPromise) {
        return browserLaunchPromise
    }

    // Create launch promise atomically
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

            // Check if it's a browser installation error
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

/**
 * Waits for page to be ready using event-based approach.
 * Waits for: page load → scripts execute → React renders → network idle
 * @param page - Playwright page instance
 * @param url - URL being loaded
 * @param config - Render configuration with timeout
 * @param alreadyNavigated - Whether page has already navigated
 */
const waitForReadiness = async (
    page: Page,
    url: string,
    config: RenderConfig,
    alreadyNavigated: boolean = false
): Promise<void> => {
    const { timeoutMs } = config
    const startTime = Date.now()
    const remainingTimeout = () => Math.max(1000, timeoutMs - (Date.now() - startTime))

    try {
        // Step 1: Navigate and wait for page load event
        if (!alreadyNavigated) {
            await page.goto(url, {
                waitUntil: 'load',
                timeout: timeoutMs
            })
        } else {
            await page.waitForLoadState('load', { timeout: remainingTimeout() })
        }

        // Step 2: Wait for network idle (ensures scripts have loaded)
        try {
            await page.waitForLoadState('networkidle', { timeout: Math.min(15000, remainingTimeout()) })
        } catch {
            // Continue if timeout
        }

        // Step 3: Wait for React/SPA to render
        // Try multiple common root selectors if custom one not provided
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
                // Try next selector
            }
        }

        // Fallback: check for text content if no children found
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
                // Continue even if React doesn't render
            }
        }

        // Step 4: Wait for network idle again (for API calls after React renders)
        try {
            await page.waitForLoadState('networkidle', { timeout: Math.min(10000, remainingTimeout()) })
        } catch {
            // Continue if timeout
        }
    } catch (err) {
        const error = err as Error
        if (!error.message.includes('timeout')) {
            throw err
        }
    }
}

/**
 * Renders a URL using Playwright, returning optimized HTML.
 * Handles concurrency limits and ensures proper cleanup of browser resources.
 * @param url - URL to render
 * @param config - Render configuration with timeout and concurrency limits
 * @param userAgent - Optional user agent string (defaults to Chrome)
 * @param origin - Optional origin header for host-based routing
 * @returns Promise resolving to rendered HTML string
 * @throws Error if concurrency limit reached or rendering fails
 */
export const render = async (
    url: string,
    config: RenderConfig,
    userAgent: string | null = null,
    origin: string | null = null
): Promise<string> => {
    // Check and increment concurrency counter
    // Note: In Node.js single-threaded event loop, this is safe as JavaScript is single-threaded.
    // However, for clarity and future-proofing, consider using a semaphore library if worker threads are introduced.
    const currentRequests = activeRequests
    if (currentRequests >= config.maxConcurrency) {
        logger.warn(`Max concurrency limit reached (${currentRequests}/${config.maxConcurrency}) for ${url}`)
        throw new Error('Max concurrency limit reached')
    }
    activeRequests++

    let context: BrowserContext | null = null
    let page: Page | null = null
    let cleanupCompleted = false

    try {
        // Ensure browser is launched
        const browserInstance = await launchBrowser()

        // Prepare extra HTTP headers
        const extraHeaders: Record<string, string> = {}
        if (origin) {
            extraHeaders['Origin'] = origin
        }

        // Create new context for isolation
        context = await browserInstance.newContext({
            userAgent:
                userAgent ||
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT },
            // Disable file system access for security
            permissions: [],
            // Block dangerous features
            javaScriptEnabled: true,
            acceptDownloads: false,
            // Set extra headers including Origin for host-based routing
            extraHTTPHeaders: extraHeaders
        })

        page = await context.newPage()

        // Block unnecessary resources for performance and set headers for host-based routing
        await page.route('**/*', route => {
            const request = route.request()
            const resourceType = request.resourceType()

            // Only allow document, script, xhr, fetch
            const allowedTypes = ['document', 'script', 'xhr', 'fetch']
            if (!allowedTypes.includes(resourceType)) {
                route.abort()
            } else {
                // Set Origin header and internal render header for host-based routing in Express
                const headers: Record<string, string> = { ...request.headers() }
                if (origin) {
                    headers['Origin'] = origin
                }
                headers['X-RenderX-Internal'] = 'true' // Mark as internal render request
                route.continue({ headers })
            }
        })

        // Navigate and wait for readiness
        await waitForReadiness(page, url, config, false)

        // Extract rendered HTML
        let html = await page.content()

        // Optimize HTML for SEO and social sharing (skip if strategy is 'ssr' as it breaks SSR websites)
        if (config.strategy !== 'ssr') {
            html = optimizeHtmlForSEO(html, config.htmlOptimizerOptions)
        }

        return html
    } catch (err) {
        const error = err as Error
        logger.error(`Render error for ${url}:`, error.message)
        throw err
    } finally {
        // Clean up with timeout protection to prevent hanging
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
                    await context.close()
                } catch (err) {
                    logger.error('Error closing context:', err)
                }
            }
            cleanupCompleted = true
        })()

        // Add timeout to cleanup to prevent hanging
        const timeoutPromise = new Promise<void>(resolve => {
            setTimeout(() => {
                if (!cleanupCompleted) {
                    logger.warn('Browser cleanup timeout - forcing cleanup')
                    // Force cleanup if timeout wins
                    if (page) {
                        page.close().catch(() => {})
                    }
                    if (context) {
                        context.close().catch(() => {})
                    }
                }
                resolve()
            }, BROWSER_CLEANUP_TIMEOUT_MS)
        })

        await Promise.race([cleanupPromise, timeoutPromise])
        activeRequests--
    }
}

/**
 * Gets the current number of active render requests.
 * @returns Current active request count
 */
export const getActiveRequests = (): number => {
    return activeRequests
}

/**
 * Pre-launches browser on startup to avoid cold start delays.
 * This is called during server initialization.
 */
export const preLaunchBrowser = async (): Promise<void> => {
    try {
        await launchBrowser()
    } catch (err) {
        // Don't fail server startup if browser launch fails
        // It will be retried on first render request
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    if (browser) {
        await browser.close()
    }
    process.exit(0)
})

process.on('SIGINT', async () => {
    if (browser) {
        await browser.close()
    }
    process.exit(0)
})
