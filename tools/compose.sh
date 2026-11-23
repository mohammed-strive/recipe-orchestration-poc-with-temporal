#!/bin/sh
# Runs the project's compose tool: $COMPOSE if set, otherwise Docker Compose if available,
# otherwise podman-compose (or `podman compose`).
#   tools/compose.sh up -d --build
#   COMPOSE=podman-compose tools/compose.sh ps
set -eu
cd "$(dirname "$0")/.."
if [ -n "${COMPOSE:-}" ]; then
  exec $COMPOSE "$@"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  exec docker compose "$@"
elif command -v podman-compose >/dev/null 2>&1; then
  exec podman-compose "$@"
elif command -v podman >/dev/null 2>&1; then
  exec podman compose "$@"
fi
echo "No compose tool found: install Docker Compose or podman-compose, or set COMPOSE." >&2
exit 1
