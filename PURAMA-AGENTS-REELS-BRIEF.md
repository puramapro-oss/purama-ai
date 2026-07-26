# PURAMA AGENTS RÉELS — BRIEF ULTIME V1.0
## Transformer Purama AI en armée d'employés IA autonomes

> **Projet** : agentiapuramafr (Vite + React + TS + Supabase + Stripe + Claude API, déployé Vercel)
> **VPS** : 72.62.191.111 (Hostinger, srv1286148)
> **Objectif** : des agents qui FONT les tâches tout seuls 24/7, comme des employés. Pas des chatbots.
> **Règle absolue** : Claude Code fait TOUT de A à Z, sans intervention de Tissma. Zéro question. Zéro étape manuelle.

---

## DÉCISION ARCHITECTURE : PLUS DE n8n POUR LES AGENTS

n8n = imports manuels, dépendance externe, fragile. On le remplace par un **moteur d'agents natif** codé directement dans le projet :

- **KARTA Engine** (sanskrit : « celui qui agit ») — service Node.js sur le VPS (PM2 ou Docker)
- **Scheduler** : CRONs internes (node-cron) + déclencheurs événements (webhook Gmail push, webhook Stripe, etc.)
- **Queue** : BullMQ + Redis (déjà dispo) — chaque tâche d'agent = un job, avec retry automatique
- **Cerveau** : Claude API avec tool-use — l'agent raisonne, choisit ses outils, agit
- **Outils (tool registry)** : Gmail (lire/envoyer), Calendar, Stripe, Supabase, DocuSeal (signature), Zernio (publication), Apollo (prospection), PDF, web search
- **Mémoire** : table `agent_memory` dans Supabase — chaque agent se souvient de ses actions, contacts, préférences apprises
- Les workflows n8n existants restent en place le temps de la migration, puis sont désactivés un par un quand l'équivalent natif est vérifié.

Résultat : Claude Code peut tout coder, tout déployer, tout tester lui-même via SSH + API. Aucun import manuel.

---

## PHASE 0 — AUDIT DE L'EXISTANT (obligatoire avant de coder)

1. Vérifier ce qui tourne VRAIMENT aujourd'hui :
   - Agent Email (workflow n8n déployé en avril) : reçoit-il les mails ? répond-il ? Tester en envoyant un mail réel.
   - Les 57 workflows n8n : lesquels s'exécutent (logs n8n), lesquels sont morts.
   - MIDAS (trading) et SUTRA (mode autonome) : confirmer qu'ils tournent.
2. Produire `AUDIT-AGENTS.md` : tableau agent | état réel | action (garder / migrer / réparer / supprimer).
3. Ne rien casser : la migration se fait agent par agent, avec test avant bascule.

---

## PHASE 1 — KARTA ENGINE (l'orchestrateur central)

Le cœur du système. Un seul service qui gère tous les agents.

- **Boucle agent** : déclencheur → contexte (mémoire + données) → Claude décide → exécute outils → logge → notifie si besoin
- **Niveaux d'autonomie par agent** (réglable par l'utilisateur) :
  - Niveau 1 : propose, l'humain valide chaque action
  - Niveau 2 : agit seul sauf actions sensibles (argent, envois massifs, signature) → validation
  - Niveau 3 : autonomie totale, rapport quotidien
- **Kill switch** : bouton pause/stop instantané par agent et global
- **Logs immuables** : chaque action horodatée dans `agent_logs` (qui, quoi, pourquoi, résultat) — visible dans le dashboard
- **Mode simulation** : avant d'activer un agent, il tourne 24h en « dry-run » et montre ce qu'il AURAIT fait
- **Collaboration inter-agents** : un agent peut déléguer à un autre (ex. Partenariat trouve un deal → délègue le contrat au Juridique → qui délègue la facture au Comptable)
- **Rapport quotidien** : chaque matin 8h, mail/notification récapitulatif de tout ce que les agents ont fait

---

## PHASE 2 — LES 4 AGENTS CŒUR (compte admin Tissma d'abord)

1. **Agent Email** (migrer depuis n8n vers KARTA) : lit Gmail en continu (push notifications Google, pas de polling), trie, répond aux mails simples, notifie pour les importants, relance sans réponse après X jours
2. **Agent Comptable** : sync Stripe + banque, catégorise, génère factures PDF, prépare les échéances (URSSAF, TVA), alerte deadlines — prépare les déclarations, l'humain valide l'envoi (obligation légale)
3. **Agent Partenariat** : cherche des prospects (Apollo), rédige l'outreach personnalisé, envoie, relance J+3/J+7, génère le contrat DocuSeal pré-signé, suit jusqu'à signature
4. **Agent Juridique** : surveille les impayés et relance, alerte les deadlines administratives, veille réglementaire hebdo

---

## PHASE 3 — TRANSFORMER LES 45 AGENTS DU SITE EN EMPLOYÉS IA (multi-tenant)

Le différenciateur mondial : ce que Lindy fait avec ~10 employés IA, Purama le fait avec 45+ intégrés à tout un écosystème.

- **Connexions client** : chaque client connecte SES comptes (Gmail OAuth, Calendar, Stripe, réseaux sociaux) — tokens chiffrés (AES-256) dans `user_connections`
- **Activation en 3 clics** : choisir l'employé → connecter le compte → régler l'autonomie → il travaille
- Les 12 agents « action » identifiés (Répondeur, Campagnes, Cold Outreach, Newsletter, Facture Pro, Rapports, Chasseur de Paiements, CRM, Suivi, Offres, Planificateur d'Appels, Réservation) passent en agents KARTA complets
- Les agents « conseil » restants gardent le chat MAIS gagnent un bouton « Fais-le pour moi » qui exécute réellement
- **Page « Mes employés IA »** : timeline d'activité en direct, stats (mails envoyés, temps gagné, € récupérés), réglages

## PHASE 4 — L'AGENT CRÉATEUR D'AGENTS

Le Saint Graal : l'utilisateur décrit en une phrase (« relance mes clients qui n'ont pas payé tous les lundis »), Claude génère la config KARTA (déclencheur + outils + prompt + limites), l'agent apparaît en mode simulation, l'utilisateur active. Personne n'a ça en français intégré à un écosystème complet.

## PHASE 5 — UX / SIMPLICITÉ

- Tout doit être compréhensible par un débutant : zéro jargon, phrases simples
- Onboarding : « Embauche ton premier employé IA en 2 minutes »
- Notifications push + email uniquement quand une décision humaine est nécessaire

---

## SÉCURITÉ & LÉGAL (non négociable)

- RGPD : consentement explicite par connexion, export/suppression des données, registre des traitements
- Actions sensibles TOUJOURS en validation humaine par défaut : paiements, virements, signature de contrats, envois >50 destinataires, déclarations fiscales
- Rate limits par agent (anti-spam, anti-ban Gmail : max 400 envois/jour/compte)
- Secrets uniquement en variables d'environnement, jamais en dur

---

## LIVRABLES ATTENDUS DE CLAUDE CODE

1. `AUDIT-AGENTS.md` (Phase 0)
2. KARTA Engine déployé sur le VPS, PM2, redémarrage auto
3. Les 4 agents cœur actifs sur le compte admin, testés de bout en bout (vrais mails de test)
4. Les 12 agents action transformés + page « Mes employés IA »
5. Agent Créateur d'Agents
6. `AGENTS-STATUS.md` : tableau final agent | état | autonomie | dernier test réussi
7. Tout committé, déployé, vérifié. Zéro action manuelle demandée à Tissma.

## PRICING & OFFRE IRRÉSISTIBLE

Plans (jamais d'« illimité ») :
- **Découverte 0€** : 100 actions/mois, 1 employé IA — pour goûter et devenir accro
- **Starter 33€** : 1 500 actions, 5 employés
- **Premium 99€** ⭐ : 6 000 actions, tous les employés
- **Ultime 199€** : 15 000 actions, tout + priorité + Agent Créateur
- Dépassement : packs +2 000 actions = 19€
- Essai Premium gratuit 14 jours sans carte

Attraction (à coder dans le produit) :
- Compteur visible en temps réel : « Tes employés IA t'ont fait gagner X heures et récupéré X € ce mois-ci »
- Onboarding « Embauche ton premier employé en 2 minutes » avec première action réussie immédiate
- Parrainage : SYSTÈME PURAMA EXISTANT (déjà intégré — vérifier et réparer, ne pas dupliquer) : parrain 50% du 1er abonnement + 10% à vie, filleul -50% sur son 1er abonnement, paliers bonus (10 filleuls→50€ … 10K→100K€), niveau 2 à 15%, espace influenceur (lien /go/[slug], cookie 7j, dashboard, contrats PDF, paiement auto), simulateur de revenus sur la page
- Rapport quotidien partageable (preuve sociale automatique)
- Compteur public sur la home : « X actions exécutées par nos employés IA cette semaine »
- Garantie : « Tes agents te font gagner du temps le 1er mois ou remboursé »
- Démo live sans inscription : un agent exécute une vraie mini-tâche sous les yeux du visiteur
- Routage IA Haiku/Sonnet selon complexité pour maximiser la marge

## ORDRE D'EXÉCUTION
Phase 0 → 1 → 2 → 3 → 4 → 5. Tester après chaque phase. Ne jamais passer à la suivante si la précédente n'est pas 100% vérifiée.
