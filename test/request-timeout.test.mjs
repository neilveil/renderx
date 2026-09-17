// A request that hits the per-request timeout must not take the server down (issue #2).
//
// The timeout middleware answers 504 and aborts the render; the handler then falls back to
// the static file and writes to the finished response. Express 4 lets that throw escape an
// async handler as an unhandled rejection, which ends the Node 20 process.
//
// No browser is needed to reach that path: with a 1ms request timeout and Playwright pointed
// at an empty browsers directory, the launch fails a few I/O hops after the timer has fired,
// and the renderer reports any failure on an aborted signal as "Render aborted". The first
// test asserts 504 so a launch failure that ever beats the timer shows up as a setup problem
// rather than a silent pass.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { findFreePort, repoRoot, request, startServer } from './helpers.mjs'

const fixtureRoot = path.join(repoRoot, '.tmp', 'test-request-timeout')
const BURST_SIZE = 3

let serverProcess
let port
let serverStderr = ''

describe('request timeout', () => {
    before(async () => {
        buildFixture()
        port = await findFreePort()
        serverProcess = await startServer({
            fixtureRoot,
            port,
            env: {
                SSR: 'true',
                REQUEST_TIMEOUT_MS: '1',
                PLAYWRIGHT_BROWSERS_PATH: path.join(fixtureRoot, 'no-browsers')
            }
        })
        serverProcess.stderr.on('data', chunk => (serverStderr += chunk))
    })

    after(() => {
        serverProcess?.kill('SIGKILL')
        fs.rmSync(fixtureRoot, { recursive: true, force: true })
    })

    it('answers a timed-out SSR request with 504', async () => {
        const burst = Array.from({ length: BURST_SIZE }, (_, index) =>
            request({ port, host: 'a.test', path: `/probe-${index}` })
        )
        const responses = await Promise.all(burst)

        for (const response of responses) {
            assert.equal(response.status, 504, `expected the timeout to win the race, got ${response.status}`)
        }
    })

    it('keeps serving after the aborted renders settle', async () => {
        await waitForAbortedRenders(BURST_SIZE)

        assert.equal(serverProcess.exitCode, null, `server exited after the timeouts:\n${serverStderr}`)

        // The 1ms timeout is still in force, so the static probe may itself lose the race and 504.
        // Either way the server answered; a dead server rejects with ECONNREFUSED
        const response = await request({ port, host: 'a.test', path: '/a-only.png' }).catch(error => {
            assert.fail(`server stopped answering: ${error.message}\n${serverStderr}`)
        })
        assert.ok([200, 504].includes(response.status), `unexpected status ${response.status}`)
    })
})

const buildFixture = () => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })

    const hostA = path.join(fixtureRoot, 'hosts', 'host-a')
    fs.mkdirSync(hostA, { recursive: true })
    fs.mkdirSync(path.join(fixtureRoot, 'no-browsers'))

    fs.writeFileSync(path.join(hostA, 'index.html'), '<html><body><div id="root">A</div></body></html>')
    fs.writeFileSync(path.join(hostA, 'a-only.png'), 'A-PNG')

    fs.writeFileSync(
        path.join(fixtureRoot, 'config.json'),
        JSON.stringify({
            logs: 'none',
            ssr: true,
            hosts: [{ source: 'host-a', host: 'a.test' }]
        })
    )
}

// The crash happened after the 504 had already left, once the aborted render unwound. Wait for
// every abort to be logged, then give the process a grace period in which it either survives
// or exits. Every timer is cleared so the suite does not outlive its own tests
const waitForAbortedRenders = expected =>
    new Promise(resolve => {
        const abortedCount = () => (serverStderr.match(/Render aborted/g) || []).length

        const finish = graceMs => {
            clearInterval(poll)
            clearTimeout(deadline)
            serverProcess.off('exit', onExit)
            setTimeout(resolve, graceMs)
        }

        const onExit = () => finish(0)
        serverProcess.once('exit', onExit)

        const poll = setInterval(() => {
            if (abortedCount() >= expected) finish(500)
        }, 20)

        const deadline = setTimeout(() => finish(0), 10000)
    })
