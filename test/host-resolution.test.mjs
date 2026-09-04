// Host resolution: one host resolves to exactly one directory, and a miss is a miss.
//
// Boots the built server against a two-tenant fixture and asserts the full matrix over raw
// HTTP, because the Host header is what is being tested and fetch() will not let us forge it.
// SSR is off so no browser is needed — every assertion here is about routing, not rendering.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repoRoot, '.tmp', 'test-host-resolution')

let serverProcess
let port

describe('host resolution', () => {
    before(async () => {
        buildFixture()
        port = await findFreePort()
        serverProcess = await startServer(port)
    })

    after(() => {
        serverProcess?.kill('SIGKILL')
        fs.rmSync(fixtureRoot, { recursive: true, force: true })
    })

    // --- A known host serves its own directory, and only its own ---

    it('serves a file the requested host owns', async () => {
        const response = await request({ host: 'a.test', path: '/a-only.png' })
        assert.equal(response.status, 200)
        assert.equal(response.body, 'A-PNG')
    })

    it('404s a file that exists only in another host', async () => {
        const response = await request({ host: 'a.test', path: '/b-only.png' })
        assert.equal(response.status, 404)
    })

    it('404s a file no host has', async () => {
        const response = await request({ host: 'a.test', path: '/missing.png' })
        assert.equal(response.status, 404)
    })

    it('404s robots.txt rather than inheriting another host\'s', async () => {
        const response = await request({ host: 'a.test', path: '/robots.txt' })
        assert.equal(response.status, 404)
    })

    // --- SPA routing still works ---

    it('serves the host index.html for an extensionless route', async () => {
        const response = await request({ host: 'a.test', path: '/some/spa/route' })
        assert.equal(response.status, 200)
        assert.equal(response.body, 'A-INDEX')
    })

    it('serves a directory index.html', async () => {
        const response = await request({ host: 'a.test', path: '/sub/' })
        assert.equal(response.status, 200)
        assert.equal(response.body, 'A-SUB-INDEX')
    })

    // --- An unknown Host is refused, for files as well as pages ---

    it('403s an unknown host at the root', async () => {
        const response = await request({ host: 'unknown.test', path: '/' })
        assert.equal(response.status, 403)
    })

    it('403s an unknown host asking for a file', async () => {
        const response = await request({ host: 'unknown.test', path: '/b-only.png' })
        assert.equal(response.status, 403)
    })

    // --- Neither of the old client-settable signals grants internal access ---

    it('ignores a forged x-renderx-internal header', async () => {
        const response = await request({
            host: 'unknown.test',
            path: '/b-only.png',
            headers: { 'X-RenderX-Internal': 'true' }
        })
        assert.equal(response.status, 403)
    })

    it('does not let a forged internal header cross tenants', async () => {
        const response = await request({
            host: 'a.test',
            path: '/b-only.png',
            headers: { 'X-RenderX-Internal': 'true' }
        })
        assert.equal(response.status, 404)
    })

    it('ignores a forged RenderX user agent', async () => {
        const response = await request({
            host: 'a.test',
            path: '/b-only.png',
            headers: { 'User-Agent': 'renderx' }
        })
        assert.equal(response.status, 404)
    })

    // --- Origin-based resolution is unchanged ---

    it('accepts a configured Origin', async () => {
        const response = await request({
            host: 'a.test',
            path: '/',
            headers: { Origin: 'http://a.test' }
        })
        assert.equal(response.status, 200)
        assert.equal(response.body, 'A-INDEX')
    })

    it('403s an unconfigured Origin', async () => {
        const response = await request({
            host: 'unknown.test',
            path: '/',
            headers: { Origin: 'http://unknown.test' }
        })
        assert.equal(response.status, 403)
    })
})

// Two tenants: host-b holds a file and a robots.txt that host-a does not, which is exactly
// what the old fallback would have handed to host-a.
const buildFixture = () => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })

    const hostA = path.join(fixtureRoot, 'hosts', 'host-a')
    const hostB = path.join(fixtureRoot, 'hosts', 'host-b')
    fs.mkdirSync(path.join(hostA, 'sub'), { recursive: true })
    fs.mkdirSync(hostB, { recursive: true })

    fs.writeFileSync(path.join(hostA, 'index.html'), 'A-INDEX')
    fs.writeFileSync(path.join(hostA, 'a-only.png'), 'A-PNG')
    fs.writeFileSync(path.join(hostA, 'sub', 'index.html'), 'A-SUB-INDEX')

    fs.writeFileSync(path.join(hostB, 'index.html'), 'B-INDEX')
    fs.writeFileSync(path.join(hostB, 'b-only.png'), 'B-PNG')
    fs.writeFileSync(path.join(hostB, 'robots.txt'), 'B-ROBOTS')

    fs.writeFileSync(
        path.join(fixtureRoot, 'config.json'),
        JSON.stringify({
            logs: 'none',
            ssr: false,
            hosts: [
                { source: 'host-a', host: 'a.test' },
                { source: 'host-b', host: 'b.test' }
            ]
        })
    )
}

const findFreePort = () =>
    new Promise(resolve => {
        const probe = net.createServer()
        probe.listen(0, () => {
            const { port: freePort } = probe.address()
            probe.close(() => resolve(freePort))
        })
    })

// config.json and ./hosts both resolve from cwd, so the fixture dir is the working directory
const startServer = (serverPort) =>
    new Promise((resolve, reject) => {
        const child = spawn('node', [path.join(repoRoot, 'dist', 'index.js')], {
            cwd: fixtureRoot,
            env: { ...process.env, PORT: String(serverPort), SSR: 'false', LOGS: 'none' }
        })

        const failed = setTimeout(() => reject(new Error('Server did not start in time')), 20000)

        child.stdout.on('data', chunk => {
            if (chunk.toString().includes('listening on port')) {
                clearTimeout(failed)
                resolve(child)
            }
        })

        child.on('error', error => {
            clearTimeout(failed)
            reject(error)
        })
    })

const request = ({ host, path: requestPath, headers = {} }) =>
    new Promise((resolve, reject) => {
        const clientRequest = http.request(
            { host: '127.0.0.1', port, path: requestPath, headers: { Host: host, ...headers } },
            response => {
                let body = ''
                response.on('data', chunk => (body += chunk))
                response.on('end', () => resolve({ status: response.statusCode, body }))
            }
        )

        clientRequest.on('error', reject)
        clientRequest.end()
    })
