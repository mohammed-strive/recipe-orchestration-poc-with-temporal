#!/bin/sh
# Podman runs container health checks from systemd timers. On hosts without systemd (WSL2
# without systemd, CI containers, some minimal VMs) the checks never run, containers stay
# "starting", and `podman-compose up` waits for them forever. This script runs the checks
# instead. Start it in a second terminal (or in the background) before `podman-compose up`:
#
#   tools/podman-healthchecks.sh &          # Ctrl-C or kill to stop
#   podman-compose up -d --build
#
# Not needed with Docker, or with Podman on a host with systemd (most Linux desktops and
# servers, and `podman machine` on macOS and Windows).
set -eu
project="${COMPOSE_PROJECT_NAME:-recipe-orchestrator-temporal-poc}"
interval="${HEALTHCHECK_INTERVAL:-5}"
echo "Running health checks for $project every ${interval}s (Ctrl-C to stop)"
while :; do
  for c in $(podman ps --filter "label=io.podman.compose.project=$project" --filter health=starting --filter health=unhealthy --filter health=healthy --format '{{.Names}}' 2>/dev/null | sort -u); do
    podman healthcheck run "$c" >/dev/null 2>&1 || true
  done
  sleep "$interval"
done
