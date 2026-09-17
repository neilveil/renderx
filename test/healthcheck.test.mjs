// Docker's HEALTHCHECK must probe the port the server listens on. That port can come from
// config.json alone, with no PORT in the container environment (issue #2).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { cleanEnv, findFreePort, repoRoot, startServer } from './helpers.mjs'

const fixtureRoot = path.join(repoRoot, '.tmp', 'test-healthcheck')

let serverProcess
let configuredPort

describe('health check', () => {
    before(async () => {
        configuredPort = await findFreePort()
        buildFixture(configuredPort)
        serverProcess = await startServer({ fixtureRoot })
    })

    after(() => {
        serverProcess?.kill('SIGKILL')
        fs.rmSync(fixtureRoot, { recursive: true, force: true })
    })

    it('passes against the port set only in config.json', async () => {
        const result = await runHealthcheck({})
        assert.equal(result.exitCode, 0, result.stderr)
    })

    it('lets PORT override config.json, so a wrong PORT fails', async () => {
        const unusedPort = await findFreePort()
        const result = await runHealthcheck({ PORT: String(unusedPort) })
        assert.equal(result.exitCode, 1)
        assert.match(result.stderr, new RegExp(`port ${unusedPort}`))
    })
})

const buildFixture = (port) => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })

    const hostA = path.join(fixtureRoot, 'hosts', 'host-a')
    fs.mkdirSync(hostA, { recursive: true })
    fs.writeFileSync(path.join(hostA, 'index.html'), 'A-INDEX')

    fs.writeFileSync(
        path.join(fixtureRoot, 'config.json'),
        JSON.stringify({
            port,
            logs: 'none',
            ssr: false,
            hosts: [{ source: 'host-a', host: 'a.test' }]
        })
    )
}

// Runs the built health check the way the Dockerfile does, from the fixture as working directory
const runHealthcheck = (env) =>
    new Promise((resolve, reject) => {
        const child = spawn('node', [path.join(repoRoot, 'dist', 'healthcheck.js')], {
            cwd: fixtureRoot,
            env: { ...cleanEnv(), ...env }
        })

        let stderr = ''
        child.stderr.on('data', chunk => (stderr += chunk))
        child.on('error', reject)
        child.on('exit', exitCode => resolve({ exitCode, stderr }))
    })
