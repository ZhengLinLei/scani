#!/usr/bin/env bash
# Clean this project's dependencies, containers, and generated output.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/scripts/common.sh"

reset=false
removeImages=false
ASSUME_YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset)
      reset=true
      ;;
    --images)
      removeImages=true
      ;;
    --yes)
      ASSUME_YES=true
      ;;
    -h|--help)
      echo 'Usage: ./CLEAN.sh [--images] [--reset [--yes]]'
      echo 'Remove dependencies, builds, exports, local caches, and project containers.'
      echo 'Keep scans and .env; --reset also deletes host data and Docker volumes after confirmation.'
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
  shift
done

command -v npm >/dev/null || die 'npm is required.'
composeOptions=(--remove-orphans)
if $reset; then
  confirmReset 'Delete ALL Scani host data and Docker volumes, including scans and HTTPS certificates?' || die 'Cancelled.'
  composeOptions+=(-v)
fi

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  composeDevelopment down "${composeOptions[@]}"
  composeProduction down "${composeOptions[@]}"
  if $removeImages; then
  for image in scani:local scani:dev; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      docker image rm "$image"
    fi
  done
  fi
else
  info 'Docker unavailable: skipping containers, images, and volumes.'
fi

npm run clean
if $reset; then
  rm -rf -- "$SCANI_ROOT/data"
fi
info 'Local cleanup complete. Source, .env, and package-lock.json preserved.'
if ! $reset; then
  info 'Scans and Docker volumes preserved.'
fi
