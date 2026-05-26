import { getConfig, LogFormat, LogLevel } from './config'

let logsLevel: LogLevel | null = null
let logFormat: LogFormat | null = null
let configInitialized = false

const getLogsLevel = (): LogLevel => {
    if (logsLevel === null || !configInitialized) {
        try {
            const config = getConfig()
            logsLevel = config.logs ?? 'ssr'
            logFormat = config.logFormat ?? (process.env.NODE_ENV === 'development' ? 'text' : 'json')
            configInitialized = true
        } catch {
            logsLevel = 'ssr'
            logFormat = 'text'
            configInitialized = false
        }
    }
    return logsLevel
}

const getLogFormat = (): LogFormat => {
    if (logFormat === null) {
        getLogsLevel()
    }
    return logFormat ?? 'text'
}

const isLoggingEnabled = (): boolean => {
    return getLogsLevel() !== 'none'
}

const formatJsonLog = (level: string, args: unknown[]): string => {
    const message = args
        .map(arg => {
            if (arg instanceof Error) return arg.message
            if (typeof arg === 'string') return arg
            return JSON.stringify(arg)
        })
        .join(' ')

    return JSON.stringify({ ts: new Date().toISOString(), level, msg: message })
}

export const logger = {
    log: (...args: unknown[]): void => {
        if (isLoggingEnabled()) {
            if (getLogFormat() === 'json') {
                console.log(formatJsonLog('info', args))
            } else {
                console.log(...args)
            }
        }
    },

    error: (...args: unknown[]): void => {
        if (getLogFormat() === 'json') {
            console.error(formatJsonLog('error', args))
        } else {
            console.error(...args)
        }
    },

    warn: (...args: unknown[]): void => {
        if (getLogFormat() === 'json') {
            console.warn(formatJsonLog('warn', args))
        } else {
            console.warn(...args)
        }
    },

    info: (...args: unknown[]): void => {
        if (isLoggingEnabled()) {
            if (getLogFormat() === 'json') {
                // If the first arg is already a JSON string (from middleware), pass through
                if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{')) {
                    console.log(args[0])
                } else {
                    console.log(formatJsonLog('info', args))
                }
            } else {
                console.log(...args)
            }
        }
    },

    debug: (...args: unknown[]): void => {
        if (isLoggingEnabled()) {
            if (getLogFormat() === 'json') {
                console.log(formatJsonLog('debug', args))
            } else {
                console.log('[DEBUG]', ...args)
            }
        }
    },

    getLogsLevel: (): LogLevel => {
        return getLogsLevel()
    }
}
