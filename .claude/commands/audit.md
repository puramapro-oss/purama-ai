---
description: Audit flash sécurité + perf sans deploy — rapide, informatif
---

Audit rapide (sans deploy) pour vérifier l'état actuel du code.

```bash
echo "=== CODE ==="
npx tsc --noEmit 2>&1 | tail -5
npm run build 2>&1 | tail -10

echo "=== PLACEHOLDERS ==="
grep -rn "TODO\|FIXME\|Lorem\|placeholder\|coming soon" src/ --include="*.tsx" --include="*.ts" | grep -v "spec\.ts\|placeholder:" | head -10

echo "=== SECRETS ==="
grep -rn "sk_live\|POSTGRES_PASSWORD\|SERVICE_ROLE_KEY" src/ | head -5

echo "=== V4.1 BREAKERS ==="
grep -rn "originstamp\|terra\.api\|tryterra\|STRIPE_CONNECT_CLIENT_ID" src/ | head -5

echo "=== BUNDLE SIZE ==="
ls -lh dist/assets/*.js 2>/dev/null | head -10 || echo "Run npm run build first"

echo "=== npm audit ==="
npm audit --production 2>&1 | grep -E "vulnerabilities|critical|high" | head -5

echo "=== PROD ==="
curl -s -o /dev/null -w "HTTP: %{http_code} | Time: %{time_total}s\n" https://purama-ai.purama.dev
```

Rapport sur chaque section avec 🟢/🟠/🔴 et une recommandation courte.
