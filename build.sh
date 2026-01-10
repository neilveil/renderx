#!/usr/bin/env bash
set -e

read -p "Enter image tag: " TAG

if [[ -z "$TAG" ]]; then
  echo "Error: tag is required"
  exit 1
fi

if [[ ! "$TAG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: tag must be in major.minor.patch format"
  exit 1
fi

IMAGE="neilveil/renderx"

docker build --platform linux/amd64,linux/arm64 -t ${IMAGE}:latest .
docker tag ${IMAGE}:latest ${IMAGE}:${TAG}

docker push ${IMAGE}:latest
docker push ${IMAGE}:${TAG}
