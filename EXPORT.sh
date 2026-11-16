#!/usr/bin/env bash
# Export Docker images plus Compose configuration for deployment without Node on the host.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/scripts/common.sh"

case "${1:-}" in
  -h|--help)
    echo 'Usage: ./EXPORT.sh'
    exit 0
    ;;
  '') ;;
  *) die "Unknown option: $1" ;;
esac
[[ $# -le 1 ]] || die 'Usage: ./EXPORT.sh'

"$SCANI_ROOT/BUILD.sh"
if ! docker image inspect caddy:2-alpine >/dev/null 2>&1; then
  docker pull caddy:2-alpine
fi

mkdir -p -- exports
stagingDirectory="$(mktemp -d "$SCANI_ROOT/exports/.export-XXXXXX")"
archivePath="$SCANI_ROOT/exports/scani-docker-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"

cleanupFailedExport() {
  rm -rf -- "$stagingDirectory"
  rm -f -- "$archivePath"
}
trap cleanupFailedExport EXIT

docker image save --output "$stagingDirectory/images.tar" scani:local caddy:2-alpine
cp -- compose.yaml Caddyfile .env.example README.md LICENSE "$stagingDirectory/"
mkdir -p -- "$stagingDirectory/context"
cp -- context/ocr-repair.txt "$stagingDirectory/context/"
tar -czf "$archivePath" -C "$stagingDirectory" -- images.tar compose.yaml Caddyfile .env.example README.md LICENSE context/ocr-repair.txt
rm -rf -- "$stagingDirectory"
trap - EXIT

info "Docker deployment bundle: $archivePath"
info 'Extract, docker load -i images.tar, configure .env, then docker compose up -d --no-build --pull never --wait.'
info 'Volumes, scans, OCR caches, .env, and certificate private keys are excluded.'
