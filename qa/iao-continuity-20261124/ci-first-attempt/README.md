# PR 108 — réception de la première CI

## Statut de cette tête

**BLOQUÉ : la première CI CHEF est terminée en échec sur Firefox.** Les jobs KARTA, site et concurrence sont réussis ; cette tête ne satisfait pas la qualification attendue.

- Dépôt : puramapro-oss/purama-ai, PR [108](https://github.com/puramapro-oss/purama-ai/pull/108).
- Tête : 2dc63a47c189e8b18cf8d05db551ef95f3057f64.
- Arbre local vérifié : b1e429d6a50c00c695dc77ac68c5c949c4ac7f94.
- Base : e81129a56e07535129827c95211d82815df8dc5a.
- Merge synthétique CHEF : 91b3a680e33aa5096bbcdced33cfbf5b2aab1736.

## Exécutions observées

| Exécution | Job | Résultat reçu |
| --- | --- | --- |
| [Identité IAO 45433919434](https://github.com/puramapro-oss/purama-ai/actions/runs/45433919434) | 138586444908 | PASS, tête exacte, typage et 206 fichiers / 4 689 tests ; projection mémoire 29 tests |
| [CHEF 45433919473](https://github.com/puramapro-oss/purama-ai/actions/runs/45433919473) | KARTA 138586437240 | PASS, merge synthétique, mêmes 4 689 tests, typage, build et audit |
| CHEF | Concurrence 138586437768 | PASS, suites de 7 + 7 + 5 tests, zéro échec/skip/annulation |
| CHEF | Appareils 138586437119 | ÉCHEC : chat 42 PASS / 3 FAIL ; autres étapes réussies |
| CHEF | Site 138586437323 | PASS, 33 fichiers / 646 tests unitaires ; atelier navigateur 5/5 ; chat standard 51/51 |

Les 4 689 tests KARTA sont exécutés deux fois dans deux qualifications ; ce ne sont pas 9 378 cas distincts. Les deux étapes optionnelles de référence Sunday de la qualification identité sont skipped.

## Matrice chat et atelier

Les 45 cas ont été exécutés, sans retry, skip ni résultat flaky. Les 30 cas antérieurs passent. Les 15 nouveaux cas donnent :

| Profil | Nouveaux PASS | Nouveaux FAIL |
| --- | ---: | ---: |
| Chromium tactile 320 × 568 | 3 | 0 |
| Firefox bureau | 0 | 3 |
| WebKit bureau | 3 | 0 |
| WebKit mobile tactile | 3 | 0 |
| WebKit tablette tactile | 3 | 0 |

Le scénario paysage utilise 844 × 390. Les autres matrices du même job passent : navigation publique 50, diagnostic WebKit 3, hors ligne 30, tactile/rotation 3. Total du job : **128 PASS / 3 FAIL** sur 131 cas, sans confondre ces moteurs Linux et viewports simulés avec des appareils physiques.

## Défaut observé

Les trois échecs sont l'assertion finale de collecte des erreurs de page, tests/chat/workshop.spec.ts:33 :

> Acquiring an exclusive Navigator LockManager lock "lock:sb-supabase-auth-token" immediately failed

Les traces indiquent Firefox **159.0** sous Linux. Chaque erreur apparaît avant le premier clic, respectivement à environ **254,970 ms**, **450,485 ms** et **459,081 ms** après le début de goto.

La pile complète remonte à src/integrations/supabase/client.ts:8, puis createClient, l'initialisation, _startAutoRefresh, _autoRefreshTokenTick et navigatorLock. Le banc remplace le hook d'identité et le transport réseau ; il conserve l'initialisation du vrai client SDK produit. Ce constat localise l'erreur mais ne suffit pas, à lui seul, à qualifier son impact dans une session de production. Aucune assertion n'a été retirée et aucune relance n'a été faite pendant cette réception.

## Preuves conservées

- chat-report.json : rapport JSON brut extrait du ZIP, avec pièces jointes runtime et réseau.
- firefox-page-errors.json : les trois événements pageError, piles complètes et chronologie des premières actions.
- device-matrix-receipt.json : les 15 résultats individuels et les runtimes observés.
- device-job-excerpts.log : résultats littéraux des cinq étapes de matrice.
- karta-and-concurrency-excerpts.log, karta-receipt.json : comptes exacts et sources de logs.
- workflow-runs.json, workflow-jobs-chef.json, workflow-jobs-identity.json : états et étapes GitHub reçus.
- source-and-artifact-receipt.json : liaison du SHA de tête au merge CI, métadonnées de l'archive et vérification de son intégrité.
- network-receipt.json : synthèse des pièces jointes réseau du rapport.
- site-job-excerpts.txt : comptes et étapes littéraux du job site réussi.
- artifacts-final.json : inventaire final des huit artefacts du run CHEF.
- final-status.json : conclusion définitive des deux workflows et des quatre jobs CHEF.
- manifest.json : empreintes des fichiers de cette réception.

Archive GitHub d'origine : ID **14941090739**, iao-device-compatibility-91b3a680e33aa5096bbcdced33cfbf5b2aab1736, **10 898 184 octets**, SHA-256 **5383794e8a4442d10395c9ea8e713fe53770767532c3c32c369db4e5ffb74a6b**. Téléchargement contrôlé : SHA identique à l'API, CRC ZIP valide, 44 membres. Le ZIP de 10,9 Mo n'est pas dupliqué dans le dépôt. L'API indique une expiration au **8 décembre 2026 à 16:14:49 UTC**.

Seul ce dossier de preuves a été écrit. Aucune source, assertion, configuration, publication ou fusion n'a été modifiée par le réceptionnaire.

Dernier relevé définitif : 2026-11-24 16:25:35 UTC.
