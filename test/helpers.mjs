// Shared harness: every suite boots the built server against a fixture directory and talks to
// it over raw http, because the Host header under test cannot be forged through fetch().

import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Every variable the server or the health check reads. A developer's shell must not leak any
// of them into a fixture, and CACHE_DIR in particular would escape the fixture cleanup
const SERVER_ENV_KEYS = [
    'PORT',
    'SSR',
    'LOGS',
    'LOG_FORMAT',
    'NODE_ENV',
    'TIMEOUT_MS',
    'REQUEST_TIMEOUT_MS',
    'PARALLEL_RENDERS',
    'MAX_CONCURRENCY',
    'CACHE_DIR',
    'CACHE_CLEANUP_INTERVAL'
]

export const cleanEnv = () => {
    const env = { ...process.env }
    for (const key of SERVER_ENV_KEYS) delete env[key]
    return env
}

export const findFreePort = () =>
    new Promise(resolve => {
        const probe = net.createServer()
        probe.listen(0, () => {
            const { port: freePort } = probe.address()
            probe.close(() => resolve(freePort))
        })
    })

// config.json and ./hosts both resolve from cwd, so the fixture dir is the working directory.
// The server runs silently with SSR off unless a suite overrides that through env.
// Leave port undefined to make the server read it from config.json instead of PORT.
export const startServer = ({ fixtureRoot, port, env = {} }) =>
    new Promise((resolve, reject) => {
        const child = spawn('node', [path.join(repoRoot, 'dist', 'index.js')], {
            cwd: fixtureRoot,
            env: { ...cleanEnv(), ...(port ? { PORT: String(port) } : {}), SSR: 'false', LOGS: 'none', ...env }
        })

        let stderr = ''
        child.stderr.on('data', chunk => (stderr += chunk))

        const failed = setTimeout(() => {
            child.kill('SIGKILL')
            reject(new Error(`Server did not start in time\n${stderr}`))
        }, 20000)

        child.stdout.on('data', chunk => {
            if (chunk.toString().includes('listening on port')) {
                clearTimeout(failed)
                resolve(child)
            }
        })

        // A boot crash (port in use, missing dist/) should fail the suite now, not after 20s
        child.on('exit', code => {
            clearTimeout(failed)
            reject(new Error(`Server exited with code ${code} before listening\n${stderr}`))
        })

        child.on('error', error => {
            clearTimeout(failed)
            reject(error)
        })
    })

export const request = ({ port, host, path: requestPath, method = 'GET', headers = {}, body }) =>
    new Promise((resolve, reject) => {
        const clientRequest = http.request(
            { host: '127.0.0.1', port, path: requestPath, method, headers: { Host: host, ...headers } },
            response => {
                let responseBody = ''
                response.on('data', chunk => (responseBody += chunk))
                response.on('end', () => resolve({ status: response.statusCode, body: responseBody }))
            }
        )

        clientRequest.on('error', reject)
        clientRequest.end(body)
    })
