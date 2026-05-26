interface HostConfig {
    source: string
    host: string
    isActive?: boolean
    timeoutMs?: number
    parallelRenders?: number
    ssr?: boolean
    rootSelector?: string
    htmlOptimizerOptions?: {
        removeDataAttributes?: boolean
        removeAriaAttributes?: boolean
        removeStyleAttributes?: boolean
        removeInlineStyles?: boolean
    }
}

interface GlobalConfig {
    port?: number
    parallelRenders?: number
    cacheCleanupInterval?: number
    ssr?: boolean
    hosts?: HostConfig[]
    logs?: 'none' | 'ssr' | 'all'
    logFormat?: 'text' | 'json'
    timeoutMs?: number
    rootSelector?: string
    clearCacheOnStartup?: boolean
    htmlOptimizerOptions?: HostConfig['htmlOptimizerOptions']
}
