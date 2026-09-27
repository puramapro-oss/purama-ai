#!/bin/bash
# Stop hook — bloque réellement une fin de turn si les garde-fous rapides échouent.
# Les suites lourdes restent dans /test-full, qa-agent et security-agent.

set -u
cd "$(dirname "$0")/../.."

PROBLEMS=0
TS_OUT="$(mktemp -t purama-tsc.XXXXXX)"
trap 'rm -f "$TS_OUT"' EXIT

# 1. TypeScript : une seule exécution, vrai code de sortie.
if ! npx tsc --noEmit >"$TS_OUT" 2>&1; then
  ERRORS=$(grep -c "error TS" "$TS_OUT" 2>/dev/null || true)
  echo "⛔ TypeScript échoue ($ERRORS erreur(s) détectée(s))."
  tail -20 "$TS_OUT"
  PROBLEMS=$((PROBLEMS + 1))
fi

# 2. Placeholders dans le code applicatif.
PLACEHOLDERS=$(grep -rnE "TODO|FIXME|Lorem|coming soon" src/ --include="*.tsx" --include="*.ts" 2>/dev/null \
  | grep -vE "placeholder:|input placeholder" | wc -l | tr -d ' ')
if [ "$PLACEHOLDERS" -gt 0 ]; then
  echo "⛔ $PLACEHOLDERS placeholder(s) détecté(s) dans src/."
  PROBLEMS=$((PROBLEMS + 1))
fi

# 3. Secrets à haut risque dans le code livré.
SECRETS=$(grep -RInE "sk_live|POSTGRES_PASSWORD|SERVICE_ROLE_KEY" src/ mobile/ karta/src/ supabase/functions/ \
  --exclude-dir=node_modules 2>/dev/null | wc -l | tr -d ' ')
if [ "$SECRETS" -gt 0 ]; then
  echo "🚨 $SECRETS motif(s) de secret à vérifier — arrêt bloqué."
  PROBLEMS=$((PROBLEMS + 1))
fi

# 4. Breakers V4.1 connus.
BREAKERS=$(grep -rnE "originstamp|terra\\.api|STRIPE_CONNECT_CLIENT_ID" src/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$BREAKERS" -gt 0 ]; then
  echo "⛔ $BREAKERS breaker(s) V4.1 détecté(s)."
  PROBLEMS=$((PROBLEMS + 1))
fi

if [ "$PROBLEMS" -eq 0 ]; then
  echo "✅ Stop gate rapide : vert."
  exit 0
fi

echo "⛔ Stop gate : $PROBLEMS catégorie(s) bloquante(s). Corriger avant de terminer."
# Claude Code traite exit 2 comme un blocage pour les événements qui supportent une décision.
exit 2
