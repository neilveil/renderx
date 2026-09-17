import http from 'http'
import { getConfig } from './config'

// Docker's HEALTHCHECK runs this file. Resolving the port through the server's own config
// loader means a port set only in config.json is probed, where an inline `PORT || 8080`
// reported a healthy container as unhealthy
const HEALTH_TIMEOUT_MS = 5000
const { port } = getConfig()

const request = http.get(`http://127.0.0.1:${port}/health`, response => {
    response.resume()
    process.exit(response.statusCode === 200 ? 0 : 1)
})

request.setTimeout(HEALTH_TIMEOUT_MS, () => {
    request.destroy(new Error(`no response within ${HEALTH_TIMEOUT_MS}ms`))
})

request.on('error', error => {
    console.error(`Health check failed on port ${port}: ${error.message}`)
    process.exit(1)
})
