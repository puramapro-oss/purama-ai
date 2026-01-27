/**
 * Configuration for all 45 AI Agents
 * Each agent has its endpoint, required fields, and field configurations
 * All agents use a simplified single message format for better UX
 */

export const N8N_BASE_URL = 'https://n8n.srv1286148.hstgr.cloud/webhook';

export interface AgentFieldConfig {
  name: string;
  type: 'text' | 'email' | 'textarea' | 'number' | 'select' | 'multiselect' | 'date' | 'time' | 'file' | 'array' | 'object' | 'boolean';
  label: string;
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  validation?: {
    min?: number;
    max?: number;
    pattern?: RegExp;
    message?: string;
  };
}

export interface AgentConfig {
  slug: string;
  name: string;
  category: string;
  endpoint: string;
  fields: AgentFieldConfig[];
  description?: string;
}

// Helper function to create a simple message-based agent config
const createSimpleAgent = (
  slug: string,
  name: string,
  category: string,
  endpoint: string,
  description: string,
  placeholder: string
): AgentConfig => ({
  slug,
  name,
  category,
  endpoint,
  description,
  fields: [
    { name: 'message', type: 'textarea', label: 'Votre message', placeholder, required: true },
  ],
});

// ==================== VENTES (5 agents) ====================

const salesAgents: AgentConfig[] = [
  createSimpleAgent(
    'crm-intelligent',
    'CRM Intelligent',
    'Ventes',
    'https://n8n.srv1286148.hstgr.cloud/webhook/crm-intelligent-auto',
    'Posez une question ou décrivez une tâche CRM à effectuer',
    'Ex: Ajoute un nouveau lead Jean Dupont de Acme Corp, email jean@exemple.com, en phase de qualification...'
  ),
  createSimpleAgent(
    'machine-de-suivi',
    'Machine de Suivi',
    'Ventes',
    'https://n8n.srv1286148.hstgr.cloud/webhook/machine-suivi-auto',
    'Décrivez le suivi ou la relance que vous souhaitez automatiser',
    'Ex: Relance le contact Marie Martin (marie@exemple.com) en phase de première relance, dernier contact il y a 5 jours...'
  ),
  createSimpleAgent(
    'buteur-principal',
    'Meilleur Marqueur IA (Lead Scoring)',
    'Ventes',
    'https://n8n.srv1286148.hstgr.cloud/webhook/buteur-principal-auto',
    'Décrivez le lead à scorer avec ses informations',
    'Ex: Score ce lead: Jean Dupont, jean@startup.com, Startup SAS, source LinkedIn, a visité 5 pages et téléchargé un ebook...'
  ),
  createSimpleAgent(
    'conclueur-de-vente',
    'Conclusion des Ventes',
    'Ventes',
    `${N8N_BASE_URL}/agent-conclueur-de-vente`,
    'Décrivez la vente à finaliser avec les détails du client et des produits',
    'Ex: Prépare une proposition pour Société ABC (client@exemple.com) pour Produit A et Service B avec 10% de remise...'
  ),
  createSimpleAgent(
    'planificateur-d-appels',
    'Planificateur d\'Appels',
    'Ventes',
    'https://n8n.srv1286148.hstgr.cloud/webhook/planificateur-appels-auto',
    'Décrivez l\'appel à planifier avec les coordonnées du contact',
    'Ex: Planifie un appel découverte avec Marie Dupont (marie@exemple.com, +33 6 12 34 56 78) demain matin...'
  ),
];

// ==================== COMMERCIALISATION (10 agents) ====================

const marketingAgents: AgentConfig[] = [
  createSimpleAgent(
    'influenceurs-pro',
    'Influenceurs Pro',
    'Commercialisation',
    `${N8N_BASE_URL}/agent-influenceurs-pro`,
    'Décrivez votre recherche d\'influenceurs',
    'Ex: Trouve des influenceurs mode en France avec 10k-100k followers pour ma marque de vêtements, budget 5000€...'
  ),
  createSimpleAgent(
    'hashtags-viraux',
    'Hashtags Viraux',
    'Commercialisation',
    `${N8N_BASE_URL}/agent-hashtags-viraux`,
    'Décrivez votre besoin en hashtags',
    'Ex: Génère 30 hashtags viraux pour Instagram dans la niche fitness/musculation...'
  ),
  createSimpleAgent(
    'predicteur-de-tendances',
    'Prédicteur de Tendances',
    'Commercialisation',
    `${N8N_BASE_URL}/agent-predicteur-de-tendances`,
    'Décrivez les tendances que vous souhaitez anticiper',
    'Ex: Quelles sont les tendances à venir dans l\'industrie tech pour les 6 prochains mois ?...'
  ),
  createSimpleAgent(
    'maitre-des-publicites',
    'Maître des Publicités',
    'Commercialisation',
    `${N8N_BASE_URL}/agent-maitre-des-publicites`,
    'Décrivez votre campagne publicitaire',
    'Ex: Crée une campagne Facebook/Instagram pour mon app mobile, budget 2000€/mois, objectif: installations...'
  ),
  createSimpleAgent(
    'gestionnaire-de-communaute',
    'Gestionnaire de Communauté',
    'Commercialisation',
    `${N8N_BASE_URL}/agent-gestionnaire-de-communaute`,
    'Décrivez le commentaire ou l\'interaction à gérer',
    'Ex: Réponds à ce commentaire Instagram de @utilisateur: "Votre produit est trop cher !" sur mon post promo...'
  ),
  createSimpleAgent(
    'seo-dominator',
    'Maître du SEO',
    'Commercialisation',
    `${N8N_BASE_URL}/agent-seo-dominator`,
    'Décrivez votre besoin SEO',
    'Ex: Rédige un article SEO de 1500 mots sur "comment améliorer son référencement" avec les mots-clés: seo, google, référencement...'
  ),
  createSimpleAgent(
    'script-video-pro',
    'Video Script Pro',
    'Commercialisation',
    `${N8N_BASE_URL}/agent-script-video-pro`,
    'Décrivez la vidéo pour laquelle vous avez besoin d\'un script',
    'Ex: Script pour une vidéo YouTube de 10 minutes sur "10 astuces productivité", ton professionnel mais accessible...'
  ),
  createSimpleAgent(
    'contenu-social',
    'Contenu Social',
    'Commercialisation',
    `${N8N_BASE_URL}/agent-contenu-social`,
    'Décrivez le contenu social à créer',
    'Ex: Crée un post Instagram et LinkedIn pour le lancement de notre nouveau produit, ton professionnel, avec hashtags...'
  ),
  createSimpleAgent(
    'oracle-des-tendances',
    'Oracle des Tendances',
    'Commercialisation',
    `${N8N_BASE_URL}/agent-oracle-des-tendances`,
    'Décrivez les tendances de marché à analyser',
    'Ex: Analyse les tendances du marché SaaS en Europe pour les 3 prochains mois...'
  ),
  createSimpleAgent(
    'espion-concurrent',
    'Espion Concurrent',
    'Commercialisation',
    `${N8N_BASE_URL}/agent-espion-concurrent`,
    'Décrivez le concurrent à analyser',
    'Ex: Analyse le concurrent XYZ (xyz.com): prix, fonctionnalités, SEO, réseaux sociaux, avis clients...'
  ),
];

// ==================== EMAIL (4 agents) ====================

const emailAgents: AgentConfig[] = [
  createSimpleAgent(
    'repondeur-intelligent',
    'Répondeur Intelligent',
    'Email',
    'https://n8n.srv1286148.hstgr.cloud/webhook/repondeur-intelligent-auto',
    'Collez l\'email reçu et indiquez le ton souhaité pour la réponse',
    'Ex: Réponds à cet email de client@exemple.com, sujet "Demande de devis", message: "Bonjour, je souhaite un devis pour..." Ton: professionnel'
  ),
  createSimpleAgent(
    'campagnes-par-courriel',
    'Campagnes par E-mail',
    'Email',
    'https://n8n.srv1286148.hstgr.cloud/webhook/campagnes-email-auto',
    'Décrivez votre campagne email',
    'Ex: Crée une campagne "Promo Été 2024" avec objet "-50% sur tout !" pour promouvoir nos soldes d\'été...'
  ),
  createSimpleAgent(
    'pro-de-la-sensibilisation-au-froid',
    'Pro de la Prospection à Froid',
    'Email',
    'https://n8n.srv1286148.hstgr.cloud/webhook/cold-outreach-auto',
    'Décrivez votre prospection à froid',
    'Ex: Email de prospection pour Jean Dupont (jean@startup.com) de Startup SAS, point de douleur: difficulté à gérer les leads...'
  ),
  createSimpleAgent(
    'newsletter-genie',
    'Newsletter Genius',
    'Email',
    'https://n8n.srv1286148.hstgr.cloud/webhook/newsletter-auto',
    'Décrivez la newsletter à créer',
    'Ex: Newsletter mensuelle pour TechNews sur les tendances tech du mois, ton informatif et expert...'
  ),
];

// ==================== LEGAL (4 agents) ====================

const legalAgents: AgentConfig[] = [
  createSimpleAgent(
    'conseiller-juridique-ia',
    'Conseiller Juridique IA',
    'Légal',
    `${N8N_BASE_URL}/agent-conseiller-juridique-ia`,
    'Posez votre question juridique',
    'Ex: Question sur un contrat de travail: mon employeur peut-il modifier mes horaires sans mon accord ?...'
  ),
  createSimpleAgent(
    'mediateur',
    'Résolveur de Litiges',
    'Légal',
    `${N8N_BASE_URL}/agent-mediateur`,
    'Décrivez le litige à résoudre',
    'Ex: Litige commercial avec Société XYZ pour 5000€, ils refusent de payer une facture de prestation...'
  ),
  createSimpleAgent(
    'usine-sous-contrat',
    'Usine sous Contrat',
    'Légal',
    `${N8N_BASE_URL}/agent-usine-sous-contrat`,
    'Décrivez le contrat à générer',
    'Ex: Génère des CGV pour Ma Société SAS, activité: e-commerce de vêtements...'
  ),
  createSimpleAgent(
    'rgpd-guardian',
    'Gardien du RGPD',
    'Légal',
    `${N8N_BASE_URL}/agent-rgpd-guardian`,
    'Décrivez votre besoin RGPD',
    'Ex: Audit de conformité RGPD pour Ma Société, site web: monsite.com, génère une politique de confidentialité...'
  ),
];

// ==================== ADMIN (4 agents) ====================

const adminAgents: AgentConfig[] = [
  createSimpleAgent(
    'remplisseur-de-formulaire',
    'Remplissage de Formulaire',
    'Admin',
    `${N8N_BASE_URL}/agent-remplisseur-de-formulaire`,
    'Décrivez le formulaire à remplir avec vos informations',
    'Ex: Formulaire URSSAF pour Ma Société (SIRET: 12345678901234), déclaration trimestrielle...'
  ),
  createSimpleAgent(
    'assistant-administratif',
    'Assistante Administrative',
    'Admin',
    `${N8N_BASE_URL}/agent-assistant-administratif`,
    'Décrivez la tâche administrative à effectuer',
    'Ex: Rédige un courrier de réclamation urgent pour la société XYZ, date limite: vendredi prochain...'
  ),
  createSimpleAgent(
    'organisateur-de-documents',
    'Organiseur de Documents',
    'Admin',
    `${N8N_BASE_URL}/agent-organisateur-de-documents`,
    'Décrivez le document à organiser/classer',
    'Ex: Classe ce document: facture_2024.pdf, facture d\'achat fournitures bureautiques chez Amazon...'
  ),
  createSimpleAgent(
    'gestionnaire-d-archives',
    'Gestionnaire d\'Archives',
    'Admin',
    `${N8N_BASE_URL}/agent-gestionnaire-d-archives`,
    'Décrivez l\'action d\'archivage souhaitée',
    'Ex: Recherche dans les archives tous les contrats signés en 2023, conservation 5 ans...'
  ),
];

// ==================== FINANCE (6 agents) ====================

const financeAgents: AgentConfig[] = [
  createSimpleAgent(
    'synchronisation-bancaire',
    'Synchronisation Bancaire',
    'Finance',
    `${N8N_BASE_URL}/agent-synchronisation-bancaire`,
    'Décrivez la synchronisation bancaire souhaitée',
    'Ex: Synchronise mon compte BNP (FR76...) du 1er au 31 janvier 2024...'
  ),
  createSimpleAgent(
    'calculateur-d-impot',
    'Calculateur d\'Impôt',
    'Finance',
    `${N8N_BASE_URL}/agent-calculateur-d-impot`,
    'Décrivez votre situation fiscale',
    'Ex: Calcule mes impôts: CA 100000€, charges 30000€, SASU à l\'IS, régime réel simplifié...'
  ),
  createSimpleAgent(
    'suivi-des-depenses',
    'Suivi des Dépenses',
    'Finance',
    `${N8N_BASE_URL}/agent-suivi-des-depenses`,
    'Décrivez la dépense à enregistrer',
    'Ex: Enregistre: Achat fournitures bureautiques 150.50€ chez Amazon le 15/01/2024...'
  ),
  createSimpleAgent(
    'chasseur-de-paiements',
    'Chasseur de Paiements',
    'Finance',
    'https://n8n.srv1286148.hstgr.cloud/webhook/chasseur-paiements-auto',
    'Décrivez la facture impayée à relancer',
    'Ex: Relance facture FAC-2024-001 de 1500€ pour client@exemple.com, échue depuis 15 jours...'
  ),
  createSimpleAgent(
    'rapports-financiers',
    'Rapports Financiers',
    'Finance',
    'https://n8n.srv1286148.hstgr.cloud/webhook/rapports-financiers-auto',
    'Décrivez le rapport financier souhaité',
    'Ex: Génère un compte de résultat (P&L) pour le trimestre en cours...'
  ),
  createSimpleAgent(
    'facture-pro',
    'Facturation Pro',
    'Finance',
    'https://n8n.srv1286148.hstgr.cloud/webhook/facture-pro-auto',
    'Décrivez la facture à créer',
    'Ex: Facture pour Société XYZ (facturation@client.com): Consultation 2h | 200€, Développement web | 500€...'
  ),
];

// ==================== CHATBOT (5 agents) ====================

const chatbotAgents: AgentConfig[] = [
  createSimpleAgent(
    'bot-whatsapp',
    'Bot WhatsApp Business',
    'Chatbot',
    `${N8N_BASE_URL}/agent-bot-whatsapp`,
    'Simulez un message WhatsApp à traiter',
    'Ex: Message de +33612345678: "Bonjour, je voudrais commander le produit X, quel est le prix ?"...'
  ),
  createSimpleAgent(
    'bot-de-messagerie',
    'Bot Messenger',
    'Chatbot',
    `${N8N_BASE_URL}/agent-bot-de-messagerie`,
    'Simulez un message Messenger à traiter',
    'Ex: Message de l\'utilisateur PSI-123: "Quels sont vos horaires d\'ouverture ?"...'
  ),
  createSimpleAgent(
    'chatbot-de-site-web',
    'Chatbot de Site Web',
    'Chatbot',
    `${N8N_BASE_URL}/agent-chatbot-de-site-web`,
    'Simulez un message de visiteur à traiter',
    'Ex: Visiteur sur la page /pricing demande: "J\'ai une question sur votre offre Premium..."...'
  ),
  createSimpleAgent(
    'bot-telegram',
    'Telegram Bot Pro',
    'Chatbot',
    `${N8N_BASE_URL}/agent-bot-telegram`,
    'Simulez un message Telegram à traiter',
    'Ex: Message du chat 123456789: "Comment puis-je annuler ma commande ?"...'
  ),
  createSimpleAgent(
    'bot-de-messagerie-instagram',
    'Bot de Messagerie Instagram',
    'Chatbot',
    `${N8N_BASE_URL}/agent-bot-de-messagerie-instagram`,
    'Simulez un DM Instagram à traiter',
    'Ex: DM de @utilisateur: "Salut ! Votre produit est-il disponible en noir ?"...'
  ),
];

// ==================== SUPPORT (4 agents) ====================

const supportAgents: AgentConfig[] = [
  createSimpleAgent(
    'sav-247',
    'SAV 24/7',
    'Support',
    `${N8N_BASE_URL}/agent-sav-247`,
    'Décrivez le problème client à résoudre',
    'Ex: Client client@exemple.com, commande CMD-2024-001: "Mon produit ne fonctionne pas, l\'écran reste noir..."'
  ),
  createSimpleAgent(
    'maitre-des-billets',
    'Ticket Master',
    'Support',
    `${N8N_BASE_URL}/agent-maitre-des-billets`,
    'Décrivez le ticket de support',
    'Ex: Ticket urgent de client@exemple.com: "Problème de connexion - impossible d\'accéder à mon compte depuis 2 jours"...'
  ),
  createSimpleAgent(
    'booster-de-critiques',
    'Booster de Révision',
    'Support',
    `${N8N_BASE_URL}/agent-booster-de-critiques`,
    'Décrivez la demande d\'avis à envoyer',
    'Ex: Demande d\'avis Google pour Jean Dupont (jean@exemple.com) après sa commande CMD-001...'
  ),
  createSimpleAgent(
    'faq-intelligente',
    'FAQ Intelligent',
    'Support',
    `${N8N_BASE_URL}/agent-faq-intelligente`,
    'Posez la question client à traiter',
    'Ex: Question client (catégorie livraison): "Quels sont les délais de livraison pour la France ?"...'
  ),
];

// ==================== ANALYTIQUE (1 agent) ====================

const analyticsAgents: AgentConfig[] = [
  createSimpleAgent(
    'tableau-de-bord-analytique',
    'Tableau de Bord Analytique',
    'Analytique',
    `${N8N_BASE_URL}/agent-tableau-de-bord-analytique`,
    'Décrivez les analyses de données souhaitées',
    'Ex: Analyse des 30 derniers jours: chiffre d\'affaires, commandes, taux de conversion, panier moyen...'
  ),
];

// ==================== PRODUCTIVITÉ (2 agents) ====================

const productivityAgents: AgentConfig[] = [
  createSimpleAgent(
    'commandant-de-tache',
    'Chef de Mission',
    'Productivité',
    `${N8N_BASE_URL}/agent-commandant-de-tache`,
    'Décrivez la tâche à gérer',
    'Ex: Tâche haute priorité pour Jean Dupont: "Préparer la présentation client pour vendredi prochain"...'
  ),
  createSimpleAgent(
    'reservation-intelligente',
    'Réservation Intelligente',
    'Productivité',
    'https://n8n.srv1286148.hstgr.cloud/webhook/reservation-intelligente-auto',
    'Décrivez la réservation à effectuer',
    'Ex: Réservation pour Marie Martin (marie@exemple.com): Consultation 1h, le 20 janvier à 14h...'
  ),
];

// ==================== ALL AGENTS COMBINED ====================

export const ALL_AGENT_CONFIGS: AgentConfig[] = [
  ...salesAgents,
  ...marketingAgents,
  ...emailAgents,
  ...legalAgents,
  ...adminAgents,
  ...financeAgents,
  ...chatbotAgents,
  ...supportAgents,
  ...analyticsAgents,
  ...productivityAgents,
];

/**
 * Get agent configuration by slug
 */
export function getAgentConfig(slug: string): AgentConfig | undefined {
  return ALL_AGENT_CONFIGS.find(config => config.slug === slug);
}

/**
 * Get agent configs by category
 */
export function getAgentsByCategory(category: string): AgentConfig[] {
  return ALL_AGENT_CONFIGS.filter(config => 
    config.category.toLowerCase() === category.toLowerCase()
  );
}

/**
 * Build webhook URL for an agent
 */
export function getAgentWebhookUrl(slug: string): string {
  return `${N8N_BASE_URL}/agent-${slug}`;
}
