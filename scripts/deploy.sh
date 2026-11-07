#!/bin/bash
# scripts/deploy.sh — ejecutar en el VPS
set -e
APP_PATH="${APP_PATH:-/opt/cashflow-app}"
cd "$APP_PATH"
git fetch origin main
git reset --hard origin/main
docker compose up -d --build
docker image prune -f
echo "Deploy completado: $(date)"
