import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { HtmlOptimizerOptions } from './htmlOptimizer'

dotenv.config()

export type RenderingStrategy = 'smart-ssr' | 'ssr' | 'csr'

// Default bots list including AI bots and common crawlers
const DEFAULT_BOTS = [
    // Search engines
    'Googlebot',
    'bingbot',
    'Slurp',
    'DuckDuckBot',
    'Baiduspider',
    'YandexBot',
    'Applebot',
    // Social media bots
    'facebookexternalhit',
    'Twitterbot',
    'LinkedInBot',
    'Pinterestbot',
    'Slack',
    'WhatsApp',
    'TelegramBot',
    'vkShare',
    // AI bots
    'GPTBot',
    'ChatGPT-User',
    'Google-Extended',
    'ClaudeBot',
    'Claude-Web',
    'GrokBot',
    'meta-externalagent',
    'meta-externalfetcher',
    'PerplexityBot',
    'Amazonbot',
    'CCBot',
    'ia_archiver',
    'YouBot',
    'Neevabot',
    // Other
    'headlessbot'
]

export interface HostConfig {
    source: string
    host: string
    isActive?: boolean // Optional, defaults to true
    // Per-host overrides (optional)
    timeoutMs?: number
    parallelRenders?: number
    bots?: string[]
    strategy?: RenderingStrategy
    rootSelector?: string // Optional root selector for SPA detection (default: '#root')
    htmlOptimizerOptions?: HtmlOptimizerOptions // Optional HTML optimizer configuration
}

export type LogLevel = 'none' | 'ssr' | 'all'

export interface GlobalConfig {
    port: number
    parallelRenders: number
    bots: string[]
    cacheCleanupInterval?: number // Cleanup interval in minutes (default: 60 minutes)
    strategy: RenderingStrategy
    hosts: HostConfig[]
    logs?: LogLevel
    rootSelector?: string // Optional root selector for SPA detection (default: '#root')
    clearCacheOnStartup?: boolean // Whether to clear all cache on startup (default: true)
    htmlOptimizerOptions?: HtmlOptimizerOptions // Optional HTML optimizer configuration
    // Legacy env var support
    timeoutMs?: number
    maxConcurrency?: number
}

let configData: GlobalConfig | null = null

const loadConfig = (): GlobalConfig => {
    if (configData) return configData

    const configPath = path.join(process.cwd(), 'config.json')
    let fileConfig: Partial<GlobalConfig> = {}

    // Try to load config.json
    if (fs.existsSync(configPath)) {
        try {
            const fileContent = fs.readFileSync(configPath, 'utf-8')
            fileConfig = JSON.parse(fileContent)
        } catch (err) {
            // Always log config errors (before logger is available)
            console.error('Failed to load config.json:', err)
        }
    }

    // Merge with environment variables (env vars take precedence)
    configData = {
        port: parseInt(process.env.PORT || fileConfig.port?.toString() || '8080', 10),
        parallelRenders: parseInt(process.env.MAX_CONCURRENCY || fileConfig.parallelRenders?.toString() || '10', 10),
        bots: fileConfig.bots && fileConfig.bots.length > 0 ? fileConfig.bots : DEFAULT_BOTS,
        cacheCleanupInterval: parseInt(
            process.env.CACHE_CLEANUP_INTERVAL || fileConfig.cacheCleanupInterval?.toString() || '60',
            10
        ), // Default: 60 minutes
        strategy: (process.env.STRATEGY || fileConfig.strategy || 'smart-ssr') as RenderingStrategy,
        hosts: fileConfig.hosts || [],
        logs: (process.env.LOGS || fileConfig.logs || 'ssr') as LogLevel,
        // Legacy support
        timeoutMs: parseInt(process.env.TIMEOUT_MS || '10000', 10),
        maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || '10', 10)
    }

    return configData
}

export const getConfig = (): GlobalConfig => {
    return loadConfig()
}

/**
 * Checks if a hostname matches a glob pattern
 * @param pattern - Glob pattern (e.g., "*", "*.my-app.com")
 * @param hostname - Hostname to match against
 * @returns true if hostname matches the pattern, false otherwise
 */
const matchesGlobPattern = (pattern: string, hostname: string): boolean => {
    // Exact match
    if (pattern === hostname) {
        return true
    }

    // Wildcard "*" matches everything
    if (pattern === '*') {
        return true
    }

    // Convert glob pattern to regex
    // Use a temporary placeholder for * to avoid escaping it
    const placeholder = '__WILDCARD_PLACEHOLDER__'
    const escapedPattern = pattern
        .replace(/\*/g, placeholder) // Replace * with placeholder
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
        .replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.*') // Replace placeholder with .*

    // Create regex: ^escapedPattern$ (anchored at start and end)
    const regexPattern = `^${escapedPattern}$`
    const regex = new RegExp(regexPattern)

    return regex.test(hostname)
}

export const getHostConfig = (hostname: string): HostConfig | null => {
    const config = loadConfig()

    // First, try exact matches (for backward compatibility and priority)
    const exactMatch = config.hosts.find(h => h.host === hostname && (h.isActive ?? true))
    if (exactMatch) {
        return exactMatch
    }

    // Then, try glob pattern matches
    const globMatch = config.hosts.find(h => matchesGlobPattern(h.host, hostname) && (h.isActive ?? true))

    return globMatch || null
}

export const getEffectiveConfig = (hostname?: string) => {
    const global = loadConfig()
    const host = hostname ? getHostConfig(hostname) : null

    // Determine botOnly based on strategy
    const renderingStrategy = (host?.strategy ?? global.strategy ?? 'smart-ssr') as RenderingStrategy
    const botOnly = renderingStrategy === 'smart-ssr' || renderingStrategy === 'csr'

    return {
        port: global.port,
        timeoutMs: host?.timeoutMs ?? global.timeoutMs ?? 10000,
        cacheTtl: (global.cacheCleanupInterval || 60) * 60, // Convert minutes to seconds
        botOnly,
        maxConcurrency: host?.parallelRenders ?? global.parallelRenders ?? global.maxConcurrency ?? 10,
        bots: host?.bots ?? global.bots ?? [],
        hostsDir: './hosts',
        source: host?.source ?? null,
        logs: global.logs ?? 'ssr',
        renderingStrategy,
        rootSelector: host?.rootSelector ?? global.rootSelector,
        clearCacheOnStartup: global.clearCacheOnStartup ?? true,
        htmlOptimizerOptions: host?.htmlOptimizerOptions ?? global.htmlOptimizerOptions
    }
}

// Default export for backward compatibility
const config = getEffectiveConfig()
export default config
