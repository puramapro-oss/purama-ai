# BRIEF — AUDIT + MISE À JOUR V5

## CONTEXTE
Cette app EXISTE DÉJÀ et est en production. Tu ne reconstruis PAS de zéro. Tu AUDITES et tu CORRIGES.

## ÉTAPE 1 — AUDIT (montrer le plan, NE PAS CODER)
Lis le CLAUDE.md + les 5 skills dans .claude/skills/. Compare avec l'app existante.

### Vérifier ces 12 points :
1. **Module /financer** : la page /financer existe ? Wizard 4 étapes ? 45 aides seedées dans la table `aides` ? Bandeau vert sur /pricing ? Si NON → ajouter
2. **Couche spirituelle** : affirmation au login ? /breathe ? /gratitude ? Citations footer ? Micro-textes empowering ? Niveaux éveil ? Si NON → ajouter
3. **Design anti-slop** : le design correspond au DOMAINE de l'app ? C'est unique ? Ou c'est du générique Inter+violet ? Si générique → refaire selon skill design-code
4. **Parrainage** : /referral fonctionne ? 3 niveaux ? Dashboard filleuls ? Si NON → corriger
5. **Wallet** : /wallet fonctionne ? Solde affiché ? Retrait dès 5€ ? Si NON → corriger
6. **Aide+SAV** : /aide avec FAQ + chatbot IA + formulaire escalade → Resend ? Si NON → ajouter
7. **Points** : système Purama Points actif ? Daily gift ? Boutique ? Si NON → ajouter
8. **i18n** : next-intl 16 langues ? Switch langue fonctionne ? Si NON → ajouter
9. **Dark/Light** : thème fonctionne VISUELLEMENT ? Si NON → corriger
10. **Auth** : inscription email + Google OAuth FONCTIONNENT ? Déconnexion propre ? Si NON → corriger
11. **Responsive** : 375px sans overflow ? Bottom tab mobile ? Sidebar desktop ? Si NON → corriger
12. **SEO+Légal** : sitemap, robots, OG, /mentions-legales, /confidentialite, /cgv, /cgu ? Si NON → ajouter

### Lister les BUGS visibles :
- curl -s URL → 200 ?
- Chaque bouton fonctionne ?
- Console 0 erreurs ?
- grep placeholder/TODO/Lorem/faux contenu ?

## ÉTAPE 2 — PLAN
Montrer à Tissma :
```
MANQUE : [liste]
BUGS : [liste]
PLAN : [ordre des corrections, feature par feature]
```
Attendre "ok" avant de coder.

## ÉTAPE 3 — CORRIGER (feature par feature)
1 correction → test → vérifier → suivante. JAMAIS tout en même temps.
Après chaque feature : tsc + build + test visuel.

## ÉTAPE 4 — DEPLOY
Quand tout est corrigé : vercel --prod --token $VERCEL_TOKEN --scope puramapro-oss --yes

## RÈGLE
NE JAMAIS casser ce qui marche déjà. Modifications CHIRURGICALES uniquement.
