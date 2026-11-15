#!/usr/bin/env bash
# Build and validate the production image entirely in Docker.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/scripts/common.sh"

buildOptions=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-cache|--pull)
      buildOptions+=("$1")
      ;;
    -h|--help)
      echo 'Usage: ./BUILD.sh [--no-cache] [--pull]'
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
  shift
done

requireDocker
composeProduction build "${buildOptions[@]}" app
info 'Production image ready: scani:local (checks, tests, and Angular build run inside Docker).'
info 'Start: docker compose up -d --wait'
