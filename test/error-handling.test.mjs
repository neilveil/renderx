// A throw inside a handler is answered by the error middleware, and an error that carries its
// own HTTP status keeps it. Express used to answer these with an HTML page; the JSON shape here
// matches every other RenderX error.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { findFreePort, repoRoot, request, startServer } from './helpers.mjs'

const fixtureRoot = path.join(repoRoot, '.tmp', 'test-error-handling')

let serverProcess
let port

describe('error handling', () => {
    before(async () => {
        buildFixture()
        port = await findFreePort()
        serverProcess = await startServer({ fixtureRoot, port })
    })

    after(() => {
        serverProcess?.kill('SIGKILL')
        fs.rmSync(fixtureRoot, { recursive: true, force: true })
    })

    it('keeps the 400 body-parser assigns to malformed JSON', async () => {
        const response = await request({
            port,
            host: 'a.test',
            method: 'POST',
            path: '/cache/invalidate',
            headers: { 'Content-Type': 'application/json' },
            body: '{bad json'
        })
        assert.equal(response.status, 400)
        assert.deepEqual(JSON.parse(response.body), { error: 'Bad Request' })
    })

    it('keeps the 413 body-parser assigns to an oversized body', async () => {
        const response = await request({
            port,
            host: 'a.test',
            method: 'POST',
            path: '/cache/invalidate',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'x'.repeat(200 * 1024) })
        })
        assert.equal(response.status, 413)
        assert.deepEqual(JSON.parse(response.body), { error: 'Payload Too Large' })
    })
})

const buildFixture = () => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })

    const hostA = path.join(fixtureRoot, 'hosts', 'host-a')
    fs.mkdirSync(hostA, { recursive: true })
    fs.writeFileSync(path.join(hostA, 'index.html'), 'A-INDEX')

    fs.writeFileSync(
        path.join(fixtureRoot, 'config.json'),
        JSON.stringify({
            logs: 'none',
            ssr: false,
            hosts: [{ source: 'host-a', host: 'a.test' }]
        })
    )
}
