---
description: Deploy purama-ai en prod avec garde-fous QA + Security + build + Lighthouse
---

Déploie `purama-ai` en production Vercel après avoir passé TOUS les garde-fous V7.1/V4.1.

## ORDRE STRICT — STOP à la première erreur

1. **Invoque l'agent qa-agent** (`.claude/agents/qa-agent.md`) → attends `VERDICT : DEPLOY OK`. Si BLOQUÉ → STOP, affiche les 22 points rouges et arrête.

2. **Invoque l'agent security-agent** (`.claude/agents/security-agent.md`) → attends `VERDICT : PROD OK`. Si BLOQUÉ → STOP.

3. **Build local** :
   ```bash
   npx tsc --noEmit
   npm run build
   ```
   0 erreur. Sinon STOP.

4. **Tests Playwright** sur preview local :
   ```bash
   npx playwright test
   ```
   0 échec. Sinon STOP.

5. **Deploy prod** (token + scope depuis CLAUDE.md §17, JAMAIS `vercel login`) :
   ```bash
   vercel --prod --token $VERCEL_TOKEN --scope puramapro-oss --yes
   ```

6. **Smoke test prod** :
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://purama-ai.purama.dev
   # Attendu : 200
   curl -s https://purama-ai.purama.dev | grep -iE "TODO|Lorem|placeholder" | wc -l
   # Attendu : 0
   ```

7. **Rapport final** :
   - URL prod
   - Commit SHA déployé
   - Statut 6 étapes (✅/❌)
   - Next action proposée

## RÈGLE

Aucune étape skippée. Aucune "on fixera après". Si bloqué → fixe puis relance `/deploy` depuis le début.
