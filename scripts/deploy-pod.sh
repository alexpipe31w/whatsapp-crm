#!/usr/bin/env bash
# Deploy del CRM en el pod. Uso (en el pod): bash ~/app/scripts/deploy-pod.sh
# - npm ci solo si cambió package-lock.json
# - copia de la BD y `prisma migrate deploy` solo si hay migraciones nuevas
# - build y reinicio de app.service
set -euo pipefail
cd ~/app

before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ]; then
  echo "[deploy] sin cambios ($after)"
else
  echo "[deploy] $before -> $after"
fi

changed=$(git diff --name-only "$before" "$after" || true)

if echo "$changed" | grep -q '^package-lock.json$'; then
  echo "[deploy] package-lock cambió: npm ci"
  npm ci
fi

if echo "$changed" | grep -q '^prisma/migrations/'; then
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  mkdir -p ~/backups
  echo "[deploy] migraciones nuevas: copia de seguridad en ~/backups/instapod-$ts.dump"
  pg_dump -d instapod -Fc -f ~/backups/instapod-"$ts".dump
  npx prisma migrate deploy
fi

npm run build
sudo systemctl reset-failed app.service || true
sudo systemctl restart app.service
sleep 15
curl -fsS localhost:3000/health && echo
echo "[deploy] OK $after"
