# Changelog

## 1.1.2

**A timed-out request can no longer take the server down.** A burst of scanner probes against an SSR host could end the Node process, and Docker's health check could report a healthy server as unhealthy. Both reported in [#2](https://github.com/neilveil/renderx/issues/2).

### Fixed

-   **Crash on request timeout.** When a render passed the 30s request timeout, the middleware answered `504` and aborted the render, and the route handler then fell back to serving `index.html` on the finished response. The resulting `ERR_HTTP_HEADERS_SENT` escaped the async handler as an unhandled rejection, which exits the process on Node 20. The response helpers now stop when the response is already answered, every async handler routes a throw to an error middleware that logs it and answers `500` when it still can, and an `unhandledRejection` handler logs anything that slips past instead of exiting.
-   **Docker health check ignored the `config.json` port.** The `HEALTHCHECK` probed `PORT` or `8080`, so a server whose port was set only in `config.json` was reported unhealthy. It now runs `dist/healthcheck.js`, which resolves the port through the same loader as the server.

### Changed

-   Errors raised by Express itself, such as a malformed JSON body on `/cache/invalidate`, keep their status and return the same JSON error shape as every other error. Express used to answer with its HTML error page.

### Added

-   `requestTimeoutMs` in `config.json`, or the `REQUEST_TIMEOUT_MS` env var, sets the per-request timeout that was fixed at 30s. A value that is not a positive number falls back to 30s with a warning at boot.
-   Request-timeout, error-handling and health-check test suites, run by `npm test`.

## 1.1.1

**Each host now resolves to exactly one directory.** Requests that previously fell back to another
host's files are now answered honestly.

### Fixed

-   **Cross-host file fallback removed.** When a file was missing from the requested host's `source`,
    the server searched every other configured host and served the first match. Any tenant's files
    were reachable from any other tenant's domain, resolved by `hosts` array order, and an unknown
    `Host` header could pull files despite the existing `403 Invalid host` policy. All three fallback
    paths are gone.
-   **Missing assets return 404.** A path with an extension that matched no file was answered with
    `200` and the host's `index.html`. The sharp edge was `robots.txt` and `sitemap.xml`: the first
    host missing one inherited another host's crawl directives. Extensionless paths still serve
    `index.html` for client-side routing.
-   **`X-RenderX-Internal` can no longer be forged.** The header was compared against the literal
    string `true`, so any client could claim to be an internal render — skipping SSR and reaching the
    more permissive file-serving path. It now carries a per-boot random token that never leaves the
    process.
-   **`RenderX/1.0` user agent is no longer trusted.** A second, equally guessable way to assert
    internal identity: `User-Agent: renderx` skipped SSR. The user agent is still sent for
    identification but grants nothing.

### Added

-   Host resolution test suite (`npm test`), run in CI before an image is published.

### Breaking

Sites that referenced a root-level asset they did not own — `/logo.png`, `/manifest.json`,
`/robots.txt` — were being served another host's copy and will now get `404`. Copy the asset into
that site's own build. Grep each host's built output for bare-root asset references before
upgrading.

## 1.1.0

Docker image published from CI on `prod-v` tag push, `ssrExclude` route globs, percent-encoded
request path decoding, and no-Origin requests resolved against the requested `Host`.
