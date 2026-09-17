import type { Response } from 'express'
import path from 'path'

// Content-hash pattern: a separator (.|-) followed by an 8+ char token that
// contains at least one digit, then the extension. Matches webpack-style
// (main.1a2b3c4d.js) and Vite-style (index-Dea4n0lr.js) hashed assets while
// excluding non-hashed names like app.production.js or styles.responsive.css.
const CONTENT_HASH_PATTERN = /[.-](?=[A-Za-z0-9_-]{8,}\.)[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\.\w+$/

// Both senders return without writing once the response has been answered. The timeout
// middleware answers 504 while a render is still in flight, and the handler then falls back to
// the static file; a second write throws ERR_HTTP_HEADERS_SENT, which Express 4 lets escape from
// an async handler as an unhandled rejection that ends the process. A write that is already
// in progress inside res.sendFile when the timer fires is caught by the error middleware instead.

export const sendError = (res: Response, statusCode: number, error: string, message?: string): void => {
    if (res.headersSent) return

    const response: { error: string; message?: string } = { error }
    if (message) {
        response.message = message
    }
    res.status(statusCode).json(response)
}

export const sendStaticFile = (res: Response, filePath: string): void => {
    if (res.headersSent) return

    const ext = path.extname(filePath).toLowerCase()

    if (ext === '.html' || ext === '.htm') {
        res.setHeader('Cache-Control', 'no-cache')
    } else if (CONTENT_HASH_PATTERN.test(path.basename(filePath))) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    }

    res.sendFile(filePath)
}
