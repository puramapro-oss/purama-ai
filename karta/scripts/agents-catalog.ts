/**
 * Catalogue des 45 agents "chat" du site (webhooks n8n réels, vérifiés via webhook_entity — cf AUDIT-AGENTS.md).
 * webhook_slug correspond exactement à la route n8n réelle enregistrée (agent-{n8n_slug}), qui diffère
 * parfois du slug frontend (ex: faq-intelligente vs agent-faq-intelligent) — d'où le champ explicite.
 * Source de vérité pour purama_ai.agents (reseed) — slug = route /agent/:slug côté frontend.
 */
export interface AgentSeed {
  slug: string;
  webhookSlug: string;
  name: string;
  category: string;
  description: string;
  icon: string;
  color: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  Ventes: "#7C3AED",
  Commercialisation: "#EC4899",
  Email: "#06B6D4",
  Légal: "#F59E0B",
  Admin: "#8B5CF6",
  Finance: "#10B981",
  Chatbot: "#3B82F6",
  Support: "#F87171",
  Analytique: "#6366F1",
  Productivité: "#14B8A6",
};

function seed(
  slug: string,
  name: string,
  category: string,
  description: string,
  icon: string,
  webhookSlug = `agent-${slug}`
): AgentSeed {
  return { slug, webhookSlug, name, category, description, icon, color: CATEGORY_COLORS[category] };
}

export const AGENTS_CATALOG: AgentSeed[] = [
  // ==================== VENTES (5) ====================
  seed("crm-intelligent", "CRM Intelligent", "Ventes", "Qualifie tes leads, suit ton pipeline et suggère la prochaine action commerciale.", "Users"),
  seed("machine-de-suivi", "Machine de Suivi", "Ventes", "Programme et personnalise tes relances commerciales automatiquement.", "Repeat"),
  seed("buteur-principal", "Meilleur Marqueur IA", "Ventes", "Score chaque lead de 1 à 100 pour prioriser tes actions commerciales.", "Target"),
  seed("conclueur-de-vente", "Conclusion des Ventes", "Ventes", "Prépare propositions et argumentaires pour closer plus vite.", "Handshake"),
  seed("planificateur-d-appels", "Planificateur d'Appels", "Ventes", "Planifie et organise tes appels commerciaux avec tes prospects.", "Phone"),

  // ==================== COMMERCIALISATION (10) ====================
  seed("influenceurs-pro", "Influenceurs Pro", "Commercialisation", "Trouve les influenceurs pertinents pour ta marque et ton budget.", "Star"),
  seed("hashtags-viraux", "Hashtags Viraux", "Commercialisation", "Génère des hashtags optimisés pour maximiser ta portée.", "Hash"),
  seed("predicteur-de-tendances", "Prédicteur de Tendances", "Commercialisation", "Anticipe les tendances de ton secteur pour garder une longueur d'avance.", "TrendingUp"),
  seed("maitre-des-publicites", "Maître des Publicités", "Commercialisation", "Optimise tes campagnes publicitaires (budget, ciblage, créas).", "Megaphone"),
  seed("gestionnaire-de-communaute", "Gestionnaire de Communauté", "Commercialisation", "Répond et modère tes interactions sur les réseaux sociaux.", "MessageSquare"),
  seed("seo-dominator", "Maître du SEO", "Commercialisation", "Rédige du contenu optimisé SEO et audite ton référencement.", "Search"),
  seed("script-video-pro", "Video Script Pro", "Commercialisation", "Écrit des scripts vidéo adaptés à ton audience et ton format.", "Video"),
  seed("contenu-social", "Contenu Social", "Commercialisation", "Crée des posts multi-plateformes cohérents avec ta marque.", "Image"),
  seed("oracle-des-tendances", "Oracle des Tendances", "Commercialisation", "Analyse les tendances de marché pour orienter ta stratégie.", "Eye"),
  seed("espion-concurrent", "Espion Concurrent", "Commercialisation", "Analyse tes concurrents : prix, SEO, réseaux, avis clients.", "Radar"),

  // ==================== EMAIL (4) ====================
  seed("repondeur-intelligent", "Répondeur Intelligent", "Email", "Rédige des réponses email professionnelles adaptées au ton souhaité.", "Reply"),
  seed("campagnes-par-courriel", "Campagnes par E-mail", "Email", "Crée et planifie tes campagnes email marketing.", "Send"),
  seed("pro-de-la-sensibilisation-au-froid", "Pro de la Prospection à Froid", "Email", "Rédige des emails de prospection à froid personnalisés.", "Mail"),
  seed("newsletter-genie", "Newsletter Genius", "Email", "Génère des newsletters engageantes sur tes sujets clés.", "Newspaper"),

  // ==================== LÉGAL (4) ====================
  seed("conseiller-juridique-ia", "Conseiller Juridique IA", "Légal", "Répond à tes questions juridiques (droit des affaires, travail, RGPD...).", "Scale"),
  seed("mediateur", "Résolveur de Litiges", "Légal", "T'aide à préparer et résoudre un litige commercial.", "Gavel"),
  seed("usine-sous-contrat", "Usine sous Contrat", "Légal", "Génère CGV, CGU et contrats adaptés à ton activité.", "FileText"),
  seed("rgpd-guardian", "Gardien du RGPD", "Légal", "Audite ta conformité RGPD et génère ta politique de confidentialité.", "ShieldCheck"),

  // ==================== ADMIN (4) ====================
  seed("remplisseur-de-formulaire", "Remplissage de Formulaire", "Admin", "Pré-remplit tes formulaires administratifs à partir de tes informations.", "ClipboardList"),
  seed("assistant-administratif", "Assistante Administrative", "Admin", "Rédige courriers et tâches administratives courantes.", "Briefcase"),
  seed("organisateur-de-documents", "Organiseur de Documents", "Admin", "Classe et catégorise automatiquement tes documents.", "FolderOpen"),
  seed("gestionnaire-d-archives", "Gestionnaire d'Archives", "Admin", "Recherche et gère tes archives selon tes règles de conservation.", "Archive"),

  // ==================== FINANCE (5 — sans page frontend dédiée avant ce reseed, cf AUDIT-AGENTS.md) ====================
  seed("synchronisation-bancaire", "Synchronisation Bancaire", "Finance", "Synchronise et rapproche tes opérations bancaires.", "Landmark"),
  seed("calculateur-d-impot", "Calculateur d'Impôt", "Finance", "Estime tes impôts et identifie des optimisations fiscales possibles.", "Calculator"),
  seed("suivi-des-depenses", "Suivi des Dépenses", "Finance", "Catégorise et suit tes dépenses professionnelles.", "Receipt"),
  seed("chasseur-de-paiements", "Chasseur de Paiements", "Finance", "Relance automatiquement tes factures impayées.", "Wallet"),
  seed("rapports-financiers", "Rapports Financiers", "Finance", "Génère tes rapports financiers mensuels (CA, charges, résultat).", "BarChart3"),
  seed("facture-pro", "Facture Pro", "Finance", "Génère des factures professionnelles conformes en quelques secondes.", "FileSpreadsheet"),

  // ==================== CHATBOT (5) ====================
  seed("bot-whatsapp", "Bot WhatsApp Business", "Chatbot", "Automatise tes réponses WhatsApp Business.", "MessageCircle"),
  seed("bot-de-messagerie", "Bot Messenger", "Chatbot", "Automatise tes réponses Facebook Messenger.", "MessageCircle"),
  seed("chatbot-de-site-web", "Chatbot de Site Web", "Chatbot", "Widget de chat intelligent pour ton site web.", "Globe"),
  seed("bot-telegram", "Telegram Bot Pro", "Chatbot", "Automatise tes réponses Telegram.", "Send"),
  seed("bot-de-messagerie-instagram", "Bot de Messagerie Instagram", "Chatbot", "Automatise tes DM Instagram.", "Instagram"),

  // ==================== SUPPORT (4) ====================
  seed("sav-247", "SAV 24/7", "Support", "Traite les demandes client à toute heure.", "Headphones"),
  seed("maitre-des-billets", "Ticket Master", "Support", "Gère et priorise tes tickets de support.", "Ticket"),
  seed("booster-de-critiques", "Booster de Révision", "Support", "Sollicite des avis clients après achat.", "Star"),
  seed("faq-intelligente", "FAQ Intelligent", "Support", "Répond aux questions fréquentes de tes clients.", "HelpCircle", "agent-faq-intelligent"),

  // ==================== ANALYTIQUE (1) ====================
  seed("tableau-de-bord-analytique", "Tableau de Bord Analytique", "Analytique", "Analyse tes données clés : CA, conversion, panier moyen.", "LayoutDashboard"),

  // ==================== PRODUCTIVITÉ (2) ====================
  seed("commandant-de-tache", "Chef de Mission", "Productivité", "Organise et priorise tes tâches selon leur urgence.", "ListChecks"),
  seed("reservation-intelligente", "Réservation Intelligente", "Productivité", "Gère tes réservations et rendez-vous automatiquement.", "CalendarCheck"),
];
