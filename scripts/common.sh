#!/usr/bin/env bash

set -euo pipefail

SCANI_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$SCANI_ROOT"

die() {
  echo "Error: $*" >&2
  exit 1
}

info() {
  echo "[Scani] $*"
}

requireDocker() {
  command -v docker >/dev/null || die 'Docker is required.'
  docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 or newer is required.'
  docker info >/dev/null 2>&1 || die 'Cannot access the Docker daemon. Start Docker and check your user permissions.'
}

composeProduction() {
  docker compose -p scani -f "$SCANI_ROOT/compose.yaml" "$@"
}

composeDevelopment() {
  docker compose -p scani-dev -f "$SCANI_ROOT/compose.dev.yaml" "$@"
}

confirmReset() {
  if [[ "${ASSUME_YES:-false}" == true ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    return 1
  fi

  local answer
  read -r -p "$1 [y/N] " answer || return 1
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes ]]
}

validatePort() {
  [[ "$1" =~ ^[1-9][0-9]{0,4}$ ]] && (( $1 <= 65535 )) || die "Invalid port: $1"
}
