#!/bin/bash
# Stop hook — bloque réellement l’arrêt si le projet est laissé dans un état cassé.
# CLAUDE.md V7.1 §6 + §28-34.

set -u
cd "$(dirname "$0")/../.."

PROBLEMS=0

# 1. TypeScript : une seule exécution, on respecte le vrai code de sortie.
TSC_OUTPUT="$(mktemp)"
trap 'rm -f "$TSC_OUTPUT"' EXIT
if ! npx tsc --noEmit >"$TSC_OUTPUT" 2>&1; then
  ERRORS="$(grep -c "error TS" "$TSC_OUTPUT" || true)"
  [ "$ERRORS" -gt 0 ] || ERRORS=1
  echo "⛔ $ERRORS erreur(s) TypeScript. Fix avant de t’arrêter."
  tail -20 "$TSC_OUTPUT"
  PROBLEMS=$((PROBLEMS + 1))
fi

# 2. Placeholders dans le code applicatif.
PLACEHOLDERS="$(grep -rn "TODO\|FIXME\|Lorem\|coming soon" src/ --include="*.tsx" --include="*.ts" 2>/dev/null | grep -v "placeholder:\|input placeholder" | wc -l | tr -d ' ')"
if [ "${PLACEHOLDERS:-0}" -gt 0 ]; then
  echo "⛔ $PLACEHOLDERS placeholder(s) détecté(s) dans src/."
  PROBLEMS=$((PROBLEMS + 1))
fi

# 3. Secrets leak.
SECRETS="$(grep -rn "sk_live\|POSTGRES_PASSWORD\|SERVICE_ROLE_KEY" src/ 2>/dev/null | wc -l | tr -d ' ')"
if [ "${SECRETS:-0}" -gt 0 ]; then
  echo "🚨 SECRET LEAK dans src/ — BLOQUANT."
  PROBLEMS=$((PROBLEMS + 1))
fi

# 4. V4.1 breakers.
BREAKERS="$(grep -rn "originstamp\|terra\.api\|STRIPE_CONNECT_CLIENT_ID" src/ 2>/dev/null | wc -l | tr -d ' ')"
if [ "${BREAKERS:-0}" -gt 0 ]; then
  echo "⛔ V4.1 breakers détectés (originstamp/terra/ca_)."
  PROBLEMS=$((PROBLEMS + 1))
fi

if [ "$PROBLEMS" -eq 0 ]; then
  echo "✅ Clean — safe to stop."
  exit 0
fi

echo "⛔ $PROBLEMS problème(s) bloquant(s) : arrêt refusé."
exit 1
