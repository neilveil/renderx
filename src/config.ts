import { randomUUID } from 'crypto'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { HtmlOptimizerOptions } from './htmlOptimizer'

dotenv.config()

// The render browser fetches pages back from this same server. Those sub-requests carry
// this token so they can be told apart from real traffic; a fixed value like "true" could
// simply be typed by anyone. Regenerated every boot and never sent to a client.
export const INTERNAL_RENDER_TOKEN = randomUUID()

export type LogFormat = 'text' | 'json'

export interface HostConfig {
    source: string
    host: string
    isActive?: boolean
    timeoutMs?: number
    parallelRenders?: number
    ssr?: boolean
    // Path globs served as plain CSR even when ssr is on, e.g. ['/app', '/app/*']
    ssrExclude?: string[]
    rootSelector?: string
    htmlOptimizerOptions?: HtmlOptimizerOptions
}

export type LogLevel = 'none' | 'ssr' | 'all'

export interface GlobalConfig {
    port: number
    parallelRenders: number
    cacheCleanupInterval?: number
    ssr: boolean
    ssrExclude?: string[]
    hosts: HostConfig[]
    logs?: LogLevel
    rootSelector?: string
    clearCacheOnStartup?: boolean
    htmlOptimizerOptions?: HtmlOptimizerOptions
    timeoutMs?: number
    logFormat?: LogFormat
}

let configData: GlobalConfig | null = null

const loadConfig = (): GlobalConfig => {
    if (configData) return configData

    const configPath = path.join(process.cwd(), 'config.json')
    let fileConfig: Partial<GlobalConfig> & {
        bots?: string[]
        maxConcurrency?: number
        strategy?: string
    } = {}

    if (fs.existsSync(configPath)) {
        try {
            const fileContent = fs.readFileSync(configPath, 'utf-8')
            fileConfig = JSON.parse(fileContent)
        } catch (err) {
            console.error('Failed to load config.json:', err)
        }
    }

    // Backward compat: warn about removed fields
    if (fileConfig.strategy) {
        console.warn('[DEPRECATED] "strategy" is removed in v2. Use "ssr": true/false instead.')
    }
    if (fileConfig.bots) {
        console.warn('[DEPRECATED] "bots" config is removed in v2. Bot detection has been removed.')
    }
    if (fileConfig.maxConcurrency) {
        console.warn('[DEPRECATED] "maxConcurrency" is removed in v2. Use "parallelRenders" instead.')
    }
    if (process.env.MAX_CONCURRENCY) {
        console.warn('[DEPRECATED] MAX_CONCURRENCY env var is removed in v2. Use PARALLEL_RENDERS instead.')
    }

    // SSR is on by default. Explicit false in config or env var SSR=false disables it.
    const ssrEnv = process.env.SSR
    const ssrEnabled = ssrEnv !== undefined ? ssrEnv !== 'false' : (fileConfig.ssr ?? true)

    const defaultLogFormat: LogFormat = process.env.NODE_ENV === 'development' ? 'text' : 'json'
    const logFormat = (process.env.LOG_FORMAT || fileConfig.logFormat || defaultLogFormat) as LogFormat

    configData = {
        port: parseInt(process.env.PORT || fileConfig.port?.toString() || '8080', 10),
        parallelRenders: parseInt(
            process.env.PARALLEL_RENDERS || process.env.MAX_CONCURRENCY || fileConfig.parallelRenders?.toString() || '10',
            10
        ),
        cacheCleanupInterval: parseInt(
            process.env.CACHE_CLEANUP_INTERVAL || fileConfig.cacheCleanupInterval?.toString() || '60',
            10
        ),
        ssr: ssrEnabled,
        ssrExclude: fileConfig.ssrExclude || [],
        hosts: fileConfig.hosts || [],
        logs: (process.env.LOGS || fileConfig.logs || 'ssr') as LogLevel,
        timeoutMs: parseInt(process.env.TIMEOUT_MS || '10000', 10),
        logFormat
    }

    return configData
}

export const getConfig = (): GlobalConfig => {
    return loadConfig()
}

// Shared `*` glob matcher used for both host patterns and SSR path exclusions.
// `*` spans any characters including `/`, so '/app/*' also covers '/app/a/b'.
const matchesGlobPattern = (pattern: string, value: string): boolean => {
    if (pattern === value) return true
    if (pattern === '*') return true

    const placeholder = '__WILDCARD_PLACEHOLDER__'
    const escapedPattern = pattern
        .replace(/\*/g, placeholder)
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.*')

    const regex = new RegExp(`^${escapedPattern}$`)
    return regex.test(value)
}

// Express leaves req.path percent-encoded, so every path inspection decodes through here.
// Returns null for malformed escape sequences, which are never valid request paths.
export const decodeRequestPath = (requestPath: string): string | null => {
    try {
        return decodeURIComponent(requestPath)
    } catch {
        return null
    }
}

// True when the request path is listed as CSR-only for this host
export const isSsrExcludedPath = (patterns: string[] | undefined, requestPath: string): boolean => {
    if (!patterns || !patterns.length) return false

    const decodedPath = decodeRequestPath(requestPath) ?? requestPath
    const normalizedPath = decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`

    return patterns.some(pattern => matchesGlobPattern(pattern, normalizedPath))
}

export const getHostConfig = (hostname: string): HostConfig | null => {
    const config = loadConfig()

    const exactMatch = config.hosts.find(host => host.host === hostname && (host.isActive ?? true))
    if (exactMatch) return exactMatch

    const globMatch = config.hosts.find(host => matchesGlobPattern(host.host, hostname) && (host.isActive ?? true))
    return globMatch || null
}

export const getEffectiveConfig = (hostname?: string): {
    port: number
    timeoutMs: number
    cacheTtl: number
    parallelRenders: number
    hostsDir: string
    source: string | null
    logs: LogLevel
    ssr: boolean
    ssrExclude: string[] | undefined
    rootSelector: string | undefined
    clearCacheOnStartup: boolean
    htmlOptimizerOptions: HtmlOptimizerOptions | undefined
    logFormat: LogFormat
} => {
    const global = loadConfig()
    const host = hostname ? getHostConfig(hostname) : null

    return {
        port: global.port,
        timeoutMs: host?.timeoutMs ?? global.timeoutMs ?? 10000,
        cacheTtl: (global.cacheCleanupInterval || 60) * 60,
        parallelRenders: host?.parallelRenders ?? global.parallelRenders ?? 10,
        hostsDir: './hosts',
        source: host?.source ?? null,
        logs: global.logs ?? 'ssr',
        ssr: host?.ssr ?? global.ssr ?? true,
        ssrExclude: host?.ssrExclude ?? global.ssrExclude,
        rootSelector: host?.rootSelector ?? global.rootSelector,
        clearCacheOnStartup: global.clearCacheOnStartup ?? true,
        htmlOptimizerOptions: host?.htmlOptimizerOptions ?? global.htmlOptimizerOptions,
        logFormat: global.logFormat ?? (process.env.NODE_ENV === 'development' ? 'text' : 'json')
    }
}

const config = getEffectiveConfig()
export default config
