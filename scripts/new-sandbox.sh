#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if lsof -tiTCP:8899 -sTCP:LISTEN >/dev/null 2>&1 || lsof -tiTCP:4173 -sTCP:LISTEN >/dev/null 2>&1 || lsof -tiTCP:4174 -sTCP:LISTEN >/dev/null 2>&1 || lsof -tiTCP:4175 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Stop the mesh relay and local validator before archiving this sandbox." >&2
  exit 1
fi
if [ -d .mesh ]; then
  mkdir -p .mesh-backups
  mesh_backup=".mesh-backups/$(date -u +%Y%m%dT%H%M%SZ)"
  mv .mesh "$mesh_backup"
  echo "Previous sandbox preserved at $mesh_backup"
fi
