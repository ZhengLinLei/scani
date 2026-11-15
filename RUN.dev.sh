#!/usr/bin/env bash
# Docker development stack: Angular live reload, API/OCR, and Caddy HTTPS.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/scripts/common.sh"

usage() {
  cat <<'HELP'
Usage: ./RUN.dev.sh [-p HTTP_PORT] [--https-port PORT]
       ./RUN.dev.sh --status | --logs | --stop | --reset [--yes]
Starts Docker Compose with live reload and persistent scans and certificates.
Defaults: http://localhost:4200 and https://localhost:8443.
--stop keeps data. --reset deletes development volumes after confirmation.
Set SCANI_ADDRESS in .env to the server's LAN IP for phone camera access.
HELP
}

action=up
ASSUME_YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)
      [[ $# -ge 2 ]] || die "$1 requires a port"
      validatePort "$2"
      export SCANI_DEV_PORT="$2"
      shift
      ;;
    --https-port)
      [[ $# -ge 2 ]] || die "$1 requires a port"
      validatePort "$2"
      export SCANI_DEV_HTTPS_PORT="$2"
      shift
      ;;
    --status)
      action=status
      ;;
    --logs)
      action=logs
      ;;
    --stop)
      action=stop
      ;;
    --reset)
      action=reset
      ;;
    --yes)
      ASSUME_YES=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1 (see ./RUN.dev.sh --help)"
      ;;
  esac
  shift
done

requireDocker
case "$action" in
  status)
    composeDevelopment ps
    ;;
  logs)
    composeDevelopment logs -f
    ;;
  stop)
    composeDevelopment stop
    info 'Development stopped; data kept.'
    ;;
  reset)
    confirmReset 'Delete development containers, scans, OCR caches, and HTTPS certificates?' || die 'Cancelled.'
    composeDevelopment down -v --remove-orphans
    ;;
  up)
    composeDevelopment up -d --build --wait --wait-timeout 180
    info 'Development ready. Published ports:'
    composeDevelopment ps
    info 'Use the configured HTTPS address on LAN devices; install the Caddy root CA first (README.md).'
    info 'Stop: ./RUN.dev.sh --stop   Delete development data: ./RUN.dev.sh --reset'
    ;;
esac
