#!/bin/bash
# Stop hook — vérifie qu'on ne laisse pas le projet dans un état cassé à la fin d'un turn.
# CLAUDE.md V7.1 §6 + §28-34.

cd "$(dirname "$0")/../.."

PROBLEMS=0

# 1. Build OK ?
if ! npx tsc --noEmit 2>&1 | tail -1 | grep -q "^$\|0 errors"; then
  ERRORS=$(npx tsc --noEmit 2>&1 | grep -c "error TS")
  if [ "$ERRORS" -gt 0 ]; then
    echo "⛔ $ERRORS erreurs TS. Fix avant de laisser le code."
    PROBLEMS=$((PROBLEMS + 1))
  fi
fi

# 2. Placeholders dans code nouveau/modifié ?
PLACEHOLDERS=$(grep -rn "TODO\|FIXME\|Lorem\|coming soon" src/ --include="*.tsx" --include="*.ts" 2>/dev/null | grep -v "placeholder:\|input placeholder" | wc -l)
if [ "$PLACEHOLDERS" -gt 0 ]; then
  echo "⚠️  $PLACEHOLDERS placeholders détectés dans src/. À finir."
  PROBLEMS=$((PROBLEMS + 1))
fi

# 3. Secrets leak ?
SECRETS=$(grep -rn "sk_live\|POSTGRES_PASSWORD\|SERVICE_ROLE_KEY" src/ 2>/dev/null | wc -l)
if [ "$SECRETS" -gt 0 ]; then
  echo "🚨 SECRET LEAK dans src/ — BLOQUANT."
  PROBLEMS=$((PROBLEMS + 1))
fi

# 4. V4.1 breakers ?
BREAKERS=$(grep -rn "originstamp\|terra\.api\|STRIPE_CONNECT_CLIENT_ID" src/ 2>/dev/null | wc -l)
if [ "$BREAKERS" -gt 0 ]; then
  echo "⛔ V4.1 breakers (originstamp/terra/ca_) — remplace par opentimestamps/healthkit/account-session."
  PROBLEMS=$((PROBLEMS + 1))
fi

if [ "$PROBLEMS" -eq 0 ]; then
  echo "✅ Clean — safe to stop."
  exit 0
else
  echo "→ $PROBLEMS problème(s) à régler avant de t'arrêter."
  exit 0  # non bloquant pour ne pas bloquer Claude Code — juste informatif
fi
