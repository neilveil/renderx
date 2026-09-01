# Docker Release CI [Auto-Generated]

## Summary

Replaced the interactive publish script with a GitHub Actions workflow that publishes `neilveil/renderx` on a `prod-v{version}` tag push, and pinned the Playwright base image to the version the project actually resolves. The old `build.sh` prompted for a tag with `read -p`, so it could only run on a laptop with Docker Desktop and a live `docker login`, and the tag it published was typed by hand rather than derived from anything.

Pinning the base cut the image from **5.08 GB to 3.75 GB** unpacked. The Dockerfile declared `playwright:v1.40.0-focal` while `package.json` said `^1.40.0`, which resolves to `1.57.0` — so `npx playwright install chromium` was downloading a second copy of Chromium instead of using the one baked into the base. With base and dependency pinned to `1.57.0`, that step drops to 0.5s.

## Changes

### CI

- Added `.github/workflows/publish.yml`, triggered on `prod-v*` tag pushes
- Fails when the tag version does not match `package.json` — the drift this workflow exists to prevent
- Fails when the version is already on Docker Hub; tags are mutable and production pins them, so an overwrite would silently change what the server pulls
- Type-checks before building, installs with `--ignore-scripts` so CI does not download browsers the image already supplies
- Builds `linux/amd64` and `linux/arm64` in one `build-push-action` invocation (the EC2 host is arm64), with GHA layer caching

### Image

- Base pinned to `mcr.microsoft.com/playwright:v1.57.0-noble`, matching the resolved Playwright version and moving off `focal` (Ubuntu 20.04, EOL April 2025)
- `playwright` pinned to an exact `1.57.0` in `package.json` so base and dependency cannot drift apart again
- Stopped baking `config.json` into the image — a failed config mount now fails loudly instead of quietly serving a demo config. The `hosts/` demo stays, so a bare `docker run` is still explorable
- `.dockerignore`: added `.github`, and fixed the stale `tmp` entry left by the `.tmp` rename

### Release path

- `build.sh` takes the version as an argument instead of prompting, verifies it against `package.json`, and uses `docker buildx --push` directly. Kept as the escape hatch when CI is unavailable
- Bumped to `1.1.0` — `ssrExclude` is a feature, so minor
- Documented releasing in `readme.md`

## Verification

Built and ran the new image locally:

| Check | Result |
|-------|--------|
| `playwright install chromium` step | 0.5s, no download |
| Image size | 5.08 GB → 3.75 GB unpacked, measured identically for both |
| Container health | `healthy`, Chromium context pool initialized |
| `/` (SSR) | Root div contains fully rendered markup |
| `/app` (`ssrExclude`) | Root div empty — genuine CSR, not just a log label |
| `/assets/aboutUs%20%281%29-BXhYVuQk.png` | `200 image/png` |

## Follow-ups

- Docker Hub access token and the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repository secrets are not yet created — the workflow cannot publish until they exist
- Prod still runs `1.0.3` and needs rolling to `1.1.0` once published

## Files

| Project | Files | Change |
|---------|-------|--------|
| renderx | `.github/workflows/publish.yml` | New publish-on-tag workflow |
| renderx | `Dockerfile` | Pinned base to `v1.57.0-noble`; dropped baked `config.json` |
| renderx | `package.json`, `package-lock.json` | Version `1.1.0`; `playwright` pinned to `1.57.0` |
| renderx | `build.sh` | Non-interactive, verifies against `package.json`, uses buildx |
| renderx | `.dockerignore` | Added `.github`; fixed stale `tmp` entry |
| renderx | `readme.md` | Added Releasing section |
