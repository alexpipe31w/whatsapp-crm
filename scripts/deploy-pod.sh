#!/usr/bin/env bash
# Deploy del CRM en el pod. Uso (en el pod): bash ~/app/scripts/deploy-pod.sh [--force]
# - sin cambios (mismo commit, sin migraciones pendientes, lock igual): no reinicia (--force lo fuerza)
# - npm ci si el hash de package-lock.json difiere del guardado (no depende del diff, así un reintento no se lo salta)
# - migraciones pendientes según el estado de la BD (prisma migrate status), no según el diff
# - compila (tsc) ANTES de tocar BD o dist; copia de la BD antes de migrar
# - health con reintentos; si falla, imprime cómo volver al commit anterior
set -euo pipefail
cd ~/app

force=0
[ "${1:-}" = "--force" ] && force=1

before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)
echo "[deploy] $before -> $after"

# npm ci por hash del lock
lock_changed=0
current_sha=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -f node_modules/.lock-sha ] || [ "$(cat node_modules/.lock-sha)" != "$current_sha" ]; then
  lock_changed=1
  echo "[deploy] package-lock distinto del instalado: npm ci"
  npm ci
  echo "$current_sha" > node_modules/.lock-sha
fi

# Migraciones pendientes según la BD.
# VERIFICAR EN EL POD: que `prisma migrate status` salga con código != 0 cuando hay
# migraciones pendientes (y 0 cuando está al día). Si no fuera así, este script no migraría.
if npx prisma migrate status >/dev/null 2>&1; then pending=0; else pending=1; fi

if [ "$before" = "$after" ] && [ "$pending" = 0 ] && [ "$lock_changed" = 0 ] && [ "$force" = 0 ]; then
  echo "[deploy] sin cambios"
  exit 0
fi

# El cliente de Prisma (src/generated, fuera de git) solo se regenera con npm ci; si el
# esquema cambió sin tocar el lock, tsc compilaría contra el cliente viejo y fallaría.
# Generarlo no toca la BD ni dist.
echo "[deploy] regenerando el cliente de Prisma"
npx prisma generate

# Comprobar que compila ANTES de tocar BD y dist (nest build borra dist al empezar)
echo "[deploy] comprobando que compila"
npx tsc --noEmit -p tsconfig.build.json

if [ "$pending" = 1 ]; then
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  mkdir -p ~/backups
  dump=~/backups/instapod-"$ts".dump
  echo "[deploy] migraciones pendientes: copia de seguridad en $dump"
  pg_dump -d instapod -Fc -f "$dump"
  [ -s "$dump" ] || { echo "[deploy] la copia está vacía o no existe: aborto antes de migrar"; exit 1; }
  npx prisma migrate deploy
fi

npm run build
sudo systemctl reset-failed app.service || true
sudo systemctl restart app.service

ok=0
for i in $(seq 1 20); do
  if curl -fsS localhost:3000/health; then ok=1; echo; break; fi
  sleep 3
done

if [ "$ok" != 1 ]; then
  echo "[deploy] FALLO: /health no respondió tras 20 intentos"
  echo "[deploy] commit anterior: $before"
  sudo journalctl -u app.service -n 50 --no-pager || true
  echo "[deploy] para volver: git checkout $before && npm run build && sudo systemctl restart app.service"
  exit 1
fi

# Retención de copias
find ~/backups -name 'instapod-*.dump' -mtime +30 -delete 2>/dev/null || true

echo "[deploy] OK $after"
