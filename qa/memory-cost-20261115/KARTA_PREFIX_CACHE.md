# KARTA — cache du préfixe public

15 novembre 2026. Branche `perf/iao-memory-cost-20261115`, base `4df3d8dd973f4b89f81158c780d21bc2811538a6`.

## Changement vérifié

`KARTA_ANTHROPIC_PROMPT_CACHE=off|5m` est une configuration serveur validée avant tout appel réel. Elle reste désactivée par défaut. En mode `5m`, une requête Anthropic native sans outils place un point de cache après le seul cadre public `ASSISTANT_CORE_POLICY`. Le rôle, les données personnelles et le contexte métier restent après ce point ; la concaténation des blocs conserve exactement le texte du système antérieur.

Les requêtes avec outils sont exclues : Anthropic inclut les définitions d'outils précédentes dans le préfixe mis en cache, et leur provenance publique ne peut pas être garantie ici. Les transports compatibles et LM Studio gardent leur requête antérieure, sans champ de cache. L'option ne modifie ni modèle, ni budget de sortie, ni reprises, ni autorisations. Les reçus d'usage existants restent la source des compteurs.

Seul le client KARTA est adapté. Le constructeur partagé `buildAssistantSystemPrompt` et les fonctions Supabase restent inchangés. La branche est ajoutée aux exclusions de déploiement Vercel ; toutes les autres règles sont conservées.

## Preuves

| Contrôle | Résultat | Preuve |
| --- | --- | --- |
| SDK installé, frontière HTTP simulée | PASS — 230 tests, 9 fichiers | `karta-targeted-tests.log` |
| Types KARTA | PASS — `npm run typecheck`, code 0 | `karta-typecheck.log` |
| Compilation KARTA | PASS — `npm run build`, code 0 | `karta-build.log` |
| ESLint TypeScript ciblé | PASS — code 0 | `karta-lint.log`, détails dans `karta-verification.json` |
| Périmètre GitNexus final | PASS — 6 fichiers, 32 symboles, 3 flux attendus ; risque MEDIUM | `karta-detect-changes.txt` |
| Diff et règle Vercel | PASS — `git diff --check` ; comparaison JSON avant/après | `karta-verification.json` |

Les tests couvrent défaut/off/on, valeurs invalides, stabilité du cadre public malgré des rôles et contextes différents, exclusion des outils, transport natif explicite, passerelles compatibles, LM Studio, modèle principal pour tâches protégées, reçus conservés avant rejet d'une réponse tronquée, absence de nouvelle tentative et limite temporelle inchangée.

L'analyse d'impact préalable du constructeur de client est LOW (deux appelants directs). Le constructeur de politique partagé est HIGH (12 appelants directs) et n'est pas modifié. L'index GitNexus est reconstruit ; son extension FTS est indisponible et certains parcours sont bornés par l'outil. Son résultat ne remplace pas les tests du transport. Les fichiers de consignes générés par l'indexation ont été remis à leur état initial pour conserver le périmètre demandé.

La comparaison de la consolidation entière à `origin/main` inclut les lots antérieurs : 1 772 fichiers, 18 325 symboles, 539 flux, risque CRITICAL. Elle ne décrit pas le seul correctif de cache et ne qualifie pas une fusion ou un déploiement de toute la consolidation. La liste affichée est plafonnée ; les comptes restent globaux (`karta-compare-main.txt`).

## Limites et activation

- NON TESTÉ : cache réellement touché, facture, qualité de génération et latence sur le compte Anthropic.
- Un préfixe sous le seuil du modèle n'est pas mis en cache. Aucun texte de remplissage n'est ajouté pour atteindre ce seuil.
- Une écriture cache peut coûter plus cher qu'une entrée normale ; les appels isolés ou sans réutilisation peuvent donc coûter davantage. Le mode est explicite et reste `off` dans l'exemple livré.
- Aucun compte, clé, fournisseur, service ni modèle n'est créé ou changé. Aucun déploiement ni activation de configuration réelle n'est effectué par ce lot.
- Avant activation, comparer les compteurs d'entrée, sortie, lecture et écriture des reçus existants sur des requêtes représentatives du modèle retenu. Ne pas confondre un test HTTP simulé avec une économie réelle.

Documentation fournisseur vérifiée : <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>.
