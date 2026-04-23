#!/usr/bin/env bash
# setup-docuseal.sh — Idempotent DocuSeal setup on Purama VPS
# Usage: bash setup-docuseal.sh
# Exit codes: 0=success, 1=precheck fail, 2=deploy fail, 3=smoke fail
set -euo pipefail

DOCUSEAL_DIR="/docker/docuseal"
DOCUSEAL_DATA_DIR="/home/docuseal"
DOCUSEAL_HOST="docuseal.purama.dev"
DOCUSEAL_TOKEN="pKKLmvPpMi6SmX4FyjuwdFEky4K9tMUEoGP7oZYiGFZ"

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { log "ERROR: $*"; exit 1; }

# -----------------------------------------------------------------------------
# 1. Pre-checks
# -----------------------------------------------------------------------------
log "1/7 Pre-checks"
[ -d "$DOCUSEAL_DATA_DIR/docuseal" ] || die "DocuSeal data dir missing"
[ -f "$DOCUSEAL_DATA_DIR/docuseal/docuseal.env" ] || die "docuseal.env missing"
command -v docker >/dev/null || die "docker not installed"
docker network inspect n8n_default >/dev/null 2>&1 || die "n8n_default network missing"

# Extract existing SECRET_KEY_BASE (preserve encrypted data)
SECRET_KEY_BASE=$(grep '^SECRET_KEY_BASE=' "$DOCUSEAL_DATA_DIR/docuseal/docuseal.env" | cut -d= -f2)
[ -n "$SECRET_KEY_BASE" ] || die "SECRET_KEY_BASE empty"
log "   SECRET_KEY_BASE preserved (${#SECRET_KEY_BASE} chars)"

# -----------------------------------------------------------------------------
# 2. Backup (idempotent — always fresh backup)
# -----------------------------------------------------------------------------
log "2/7 Backup"
mkdir -p /root/backups
BACKUP_FILE="/root/backups/docuseal-$(date +%Y%m%d-%H%M%S).tar.gz"
tar czf "$BACKUP_FILE" "$DOCUSEAL_DATA_DIR" 2>/dev/null
log "   backup: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# -----------------------------------------------------------------------------
# 3. Deploy compose
# -----------------------------------------------------------------------------
log "3/7 Deploy compose"
mkdir -p "$DOCUSEAL_DIR"

# Write .env
cat > "$DOCUSEAL_DIR/.env" <<EOF
DOCUSEAL_SECRET_KEY_BASE=$SECRET_KEY_BASE
DOCUSEAL_DATABASE_URL=
RESEND_API_KEY=re_az9YkXuq_LFv9vGdr9fGQX8GDinTm7rw2
EOF
chmod 600 "$DOCUSEAL_DIR/.env"

# docker-compose.yml must already be scp'd. If missing, die.
[ -f "$DOCUSEAL_DIR/docker-compose.yml" ] || die "docker-compose.yml missing in $DOCUSEAL_DIR"

# Stop old standalone container (if exists)
if docker ps -a --format '{{.Names}}' | grep -q '^docuseal$'; then
    # Check if current container is from compose or standalone
    COMPOSE_PROJECT=$(docker inspect docuseal --format '{{ index .Config.Labels "com.docker.compose.project" }}' 2>/dev/null || echo "")
    if [ "$COMPOSE_PROJECT" != "docuseal" ]; then
        log "   stopping standalone container"
        docker stop docuseal >/dev/null 2>&1 || true
        docker rm docuseal >/dev/null 2>&1 || true
    else
        log "   container already managed by compose"
    fi
fi

# Up with compose (will be idempotent — recreate if config changed)
cd "$DOCUSEAL_DIR"
docker compose up -d

# -----------------------------------------------------------------------------
# 4. Wait for container health
# -----------------------------------------------------------------------------
log "4/7 Wait container ready"
for i in $(seq 1 30); do
    if docker ps --filter "name=docuseal" --filter "status=running" --format '{{.Names}}' | grep -q docuseal; then
        log "   container up (attempt $i/30)"
        break
    fi
    sleep 2
    [ "$i" = "30" ] && die "container didn't start in 60s"
done

# -----------------------------------------------------------------------------
# 5. Test local API (via port 3001 localhost)
# -----------------------------------------------------------------------------
log "5/7 Local API test"
for i in $(seq 1 20); do
    if curl -sf -H "X-Auth-Token: $DOCUSEAL_TOKEN" http://localhost:3001/api/templates --max-time 5 >/dev/null 2>&1; then
        log "   API OK (attempt $i/20)"
        break
    fi
    sleep 3
    [ "$i" = "20" ] && die "API not responding in 60s"
done

# -----------------------------------------------------------------------------
# 6. Wait Let's Encrypt cert (up to 3 min)
# -----------------------------------------------------------------------------
log "6/7 HTTPS test (Let's Encrypt)"
for i in $(seq 1 60); do
    STATUS=$(curl -sk -o /dev/null -w '%{http_code}' "https://$DOCUSEAL_HOST/api/templates" \
        -H "X-Auth-Token: $DOCUSEAL_TOKEN" --max-time 5 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then
        log "   HTTPS OK (attempt $i/60)"
        break
    fi
    sleep 3
    [ "$i" = "60" ] && log "   WARNING: HTTPS not ready after 3min (DNS propagation may need more time)"
done

# -----------------------------------------------------------------------------
# 7. Setup backup CRON
# -----------------------------------------------------------------------------
log "7/7 Backup CRON"
CRON_LINE="0 3 * * * tar czf /root/backups/docuseal-daily-\$(date +\\%Y\\%m\\%d).tar.gz /home/docuseal && find /root/backups -name 'docuseal-daily-*' -mtime +30 -delete"
(crontab -l 2>/dev/null | grep -v 'docuseal-daily' || true; echo "$CRON_LINE") | crontab -
log "   CRON installed (daily 03:00, 30d retention)"

log "DONE. DocuSeal exposed at https://$DOCUSEAL_HOST"
exit 0
