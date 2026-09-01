#!/usr/bin/env bash
set -e

# Escape hatch for publishing by hand when CI is unavailable. The normal path is to push a
# prod-v{version} tag and let .github/workflows/publish.yml do it.
#
# Usage: ./build.sh 1.1.0

TAG="$1"

if [[ -z "$TAG" ]]; then
  echo "Usage: ./build.sh <version>   e.g. ./build.sh 1.1.0"
  exit 1
fi

if [[ ! "$TAG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be in major.minor.patch format"
  exit 1
fi

PACKAGE_VERSION=$(node -p "require('./package.json').version")

if [[ "$TAG" != "$PACKAGE_VERSION" ]]; then
  echo "Error: version $TAG does not match package.json ($PACKAGE_VERSION)"
  exit 1
fi

IMAGE="neilveil/renderx"

# Both architectures in one invocation — a multi-arch manifest cannot be produced by
# building locally and tagging afterwards
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag "${IMAGE}:${TAG}" \
  --tag "${IMAGE}:latest" \
  --push \
  .
