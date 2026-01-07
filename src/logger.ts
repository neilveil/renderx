import { getConfig, LogLevel } from './config'

let logsLevel: LogLevel | null = null
let configInitialized = false

/**
 * Lazy initialization of logs setting to avoid circular dependencies.
 * The config is loaded on first access, ensuring it's fully initialized.
 */
const getLogsLevel = (): LogLevel => {
    if (logsLevel === null || !configInitialized) {
        try {
            const config = getConfig()
            logsLevel = config.logs ?? 'ssr'
            configInitialized = true
        } catch (err) {
            // If config not ready, default to 'ssr'
            logsLevel = 'ssr'
            configInitialized = false
        }
    }
    return logsLevel
}

/**
 * Checks if general logging is enabled (logs !== 'none')
 */
const isLoggingEnabled = (): boolean => {
    return getLogsLevel() !== 'none'
}

/**
 * Logger utility with configurable log levels.
 * Errors and warnings are always logged, while info/debug/log respect logs setting.
 */
export const logger = {
    /**
     * Logs a message if logging is enabled (logs !== 'none')
     */
    log: (...args: unknown[]): void => {
        if (isLoggingEnabled()) {
            console.log(...args)
        }
    },
    /**
     * Logs an error message (always logged regardless of logs setting)
     */
    error: (...args: any[]): void => {
        // Always log errors
        console.error(...args)
    },
    /**
     * Logs a warning message (always logged regardless of logs setting)
     */
    warn: (...args: any[]): void => {
        // Always log warnings
        console.warn(...args)
    },
    /**
     * Logs an info message if logging is enabled (logs !== 'none')
     */
    info: (...args: any[]): void => {
        if (isLoggingEnabled()) {
            console.log(...args)
        }
    },
    /**
     * Logs a debug message if logging is enabled (logs !== 'none')
     */
    debug: (...args: any[]): void => {
        if (isLoggingEnabled()) {
            console.log('[DEBUG]', ...args)
        }
    },
    /**
     * Gets the current logs level
     */
    getLogsLevel: (): LogLevel => {
        return getLogsLevel()
    }
}
