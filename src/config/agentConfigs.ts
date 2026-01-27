/**
 * Configuration for all 45 AI Agents
 * Each agent has its endpoint, required fields, and field configurations
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

// ==================== VENTES (5 agents) ====================

const salesAgents: AgentConfig[] = [
  {
    slug: 'crm-intelligent',
    name: 'CRM Intelligent',
    category: 'Ventes',
    endpoint: `${N8N_BASE_URL}/agent-crm-intelligent`,
    description: 'Posez une question ou décrivez une tâche CRM à effectuer',
    fields: [
      { name: 'message', type: 'textarea', label: 'Votre message', placeholder: 'Ex: Ajoute un nouveau lead Jean Dupont de Acme Corp, email jean@exemple.com, en phase de qualification...', required: true },
    ],
  },
  {
    slug: 'machine-de-suivi',
    name: 'Machine de Suivi',
    category: 'Ventes',
    endpoint: `${N8N_BASE_URL}/agent-machine-de-suivi`,
    description: 'Automatisez le suivi de vos prospects',
    fields: [
      { name: 'email', type: 'email', label: 'Email du contact', placeholder: 'contact@exemple.com', required: true },
      { name: 'name', type: 'text', label: 'Nom du contact', placeholder: 'Marie Martin', required: true },
      { name: 'last_contact', type: 'date', label: 'Dernier contact', required: false },
      { name: 'stage', type: 'select', label: 'Étape', required: true, options: [
        { value: 'premier_contact', label: 'Premier contact' },
        { value: 'relance_1', label: 'Relance 1' },
        { value: 'relance_2', label: 'Relance 2' },
        { value: 'relance_finale', label: 'Relance finale' },
      ]},
    ],
  },
  {
    slug: 'buteur-principal',
    name: 'Meilleur Marqueur IA (Lead Scoring)',
    category: 'Ventes',
    endpoint: `${N8N_BASE_URL}/agent-buteur-principal`,
    description: 'Scorez automatiquement vos leads pour prioriser vos efforts',
    fields: [
      { name: 'email', type: 'email', label: 'Email', placeholder: 'lead@exemple.com', required: true },
      { name: 'name', type: 'text', label: 'Nom', placeholder: 'Jean Dupont', required: true },
      { name: 'company', type: 'text', label: 'Entreprise', placeholder: 'Startup SAS', required: false },
      { name: 'source', type: 'select', label: 'Source', required: true, options: [
        { value: 'website', label: 'Site web' },
        { value: 'linkedin', label: 'LinkedIn' },
        { value: 'referral', label: 'Recommandation' },
        { value: 'ads', label: 'Publicités' },
        { value: 'event', label: 'Événement' },
        { value: 'cold_outreach', label: 'Prospection' },
      ]},
      { name: 'behavior', type: 'textarea', label: 'Comportement observé', placeholder: 'A visité 5 pages, téléchargé un ebook...', required: false },
    ],
  },
  {
    slug: 'conclueur-de-vente',
    name: 'Conclusion des Ventes',
    category: 'Ventes',
    endpoint: `${N8N_BASE_URL}/agent-conclueur-de-vente`,
    description: 'Finalisez vos ventes avec des propositions personnalisées',
    fields: [
      { name: 'client_name', type: 'text', label: 'Nom du client', placeholder: 'Société ABC', required: true },
      { name: 'email', type: 'email', label: 'Email', placeholder: 'client@exemple.com', required: true },
      { name: 'products', type: 'textarea', label: 'Produits/Services (un par ligne)', placeholder: 'Produit A\nProduit B\nService C', required: true },
      { name: 'discount', type: 'number', label: 'Remise (%)', placeholder: '10', required: false, validation: { min: 0, max: 100 } },
    ],
  },
  {
    slug: 'planificateur-d-appels',
    name: 'Planificateur d\'Appels',
    category: 'Ventes',
    endpoint: `${N8N_BASE_URL}/agent-planificateur-d-appels`,
    description: 'Planifiez et gérez vos appels commerciaux',
    fields: [
      { name: 'name', type: 'text', label: 'Nom du contact', placeholder: 'Marie Dupont', required: true },
      { name: 'email', type: 'email', label: 'Email', placeholder: 'marie@exemple.com', required: true },
      { name: 'phone', type: 'text', label: 'Téléphone', placeholder: '+33 6 12 34 56 78', required: true },
      { name: 'preferred_time', type: 'select', label: 'Créneau préféré', required: true, options: [
        { value: 'matin', label: 'Matin (9h-12h)' },
        { value: 'apres-midi', label: 'Après-midi (14h-18h)' },
        { value: 'soir', label: 'Soir (18h-20h)' },
      ]},
      { name: 'call_type', type: 'select', label: 'Type d\'appel', required: true, options: [
        { value: 'decouverte', label: 'Découverte' },
        { value: 'demo', label: 'Démonstration' },
        { value: 'negociation', label: 'Négociation' },
        { value: 'closing', label: 'Closing' },
        { value: 'suivi', label: 'Suivi' },
      ]},
    ],
  },
];

// ==================== COMMERCIALISATION (10 agents) ====================

const marketingAgents: AgentConfig[] = [
  {
    slug: 'influenceurs-pro',
    name: 'Influenceurs Pro',
    category: 'Commercialisation',
    endpoint: `${N8N_BASE_URL}/agent-influenceurs-pro`,
    description: 'Trouvez les influenceurs parfaits pour votre marque',
    fields: [
      { name: 'brand_name', type: 'text', label: 'Nom de la marque', placeholder: 'Ma Marque', required: true },
      { name: 'niche', type: 'text', label: 'Niche/Secteur', placeholder: 'Mode, Tech, Beauté...', required: true },
      { name: 'countries', type: 'text', label: 'Pays ciblés', placeholder: 'France, Belgique, Suisse', required: false },
      { name: 'min_followers', type: 'number', label: 'Followers minimum', placeholder: '10000', required: false },
      { name: 'max_followers', type: 'number', label: 'Followers maximum', placeholder: '500000', required: false },
      { name: 'budget', type: 'number', label: 'Budget (€)', placeholder: '5000', required: false },
    ],
  },
  {
    slug: 'hashtags-viraux',
    name: 'Hashtags Viraux',
    category: 'Commercialisation',
    endpoint: `${N8N_BASE_URL}/agent-hashtags-viraux`,
    description: 'Générez des hashtags viraux pour vos publications',
    fields: [
      { name: 'niche', type: 'text', label: 'Niche/Thème', placeholder: 'Fitness, Voyage, Food...', required: true },
      { name: 'platform', type: 'select', label: 'Plateforme', required: true, options: [
        { value: 'instagram', label: 'Instagram' },
        { value: 'tiktok', label: 'TikTok' },
        { value: 'twitter', label: 'Twitter/X' },
        { value: 'linkedin', label: 'LinkedIn' },
        { value: 'youtube', label: 'YouTube' },
      ]},
      { name: 'count', type: 'number', label: 'Nombre de hashtags', placeholder: '30', required: false, validation: { min: 5, max: 50 } },
    ],
  },
  {
    slug: 'predicteur-de-tendances',
    name: 'Prédicteur de Tendances',
    category: 'Commercialisation',
    endpoint: `${N8N_BASE_URL}/agent-predicteur-de-tendances`,
    description: 'Anticipez les tendances de votre industrie',
    fields: [
      { name: 'topic', type: 'text', label: 'Sujet/Thème', placeholder: 'Intelligence artificielle', required: true },
      { name: 'industry', type: 'select', label: 'Industrie', required: true, options: [
        { value: 'tech', label: 'Technologie' },
        { value: 'fashion', label: 'Mode' },
        { value: 'food', label: 'Alimentation' },
        { value: 'health', label: 'Santé' },
        { value: 'finance', label: 'Finance' },
        { value: 'entertainment', label: 'Divertissement' },
        { value: 'other', label: 'Autre' },
      ]},
    ],
  },
  {
    slug: 'maitre-des-publicites',
    name: 'Maître des Publicités',
    category: 'Commercialisation',
    endpoint: `${N8N_BASE_URL}/agent-maitre-des-publicites`,
    description: 'Créez des campagnes publicitaires performantes',
    fields: [
      { name: 'brand_name', type: 'text', label: 'Nom de la marque', placeholder: 'Ma Marque', required: true },
      { name: 'product', type: 'text', label: 'Produit/Service', placeholder: 'Application mobile', required: true },
      { name: 'platforms', type: 'multiselect', label: 'Plateformes', required: true, options: [
        { value: 'facebook', label: 'Facebook' },
        { value: 'instagram', label: 'Instagram' },
        { value: 'google', label: 'Google Ads' },
        { value: 'tiktok', label: 'TikTok' },
        { value: 'linkedin', label: 'LinkedIn' },
        { value: 'youtube', label: 'YouTube' },
      ]},
      { name: 'budget', type: 'number', label: 'Budget mensuel (€)', placeholder: '2000', required: true },
      { name: 'objective', type: 'select', label: 'Objectif', required: true, options: [
        { value: 'awareness', label: 'Notoriété' },
        { value: 'traffic', label: 'Trafic' },
        { value: 'leads', label: 'Génération de leads' },
        { value: 'sales', label: 'Conversions/Ventes' },
        { value: 'app_installs', label: 'Installations d\'app' },
      ]},
    ],
  },
  {
    slug: 'gestionnaire-de-communaute',
    name: 'Gestionnaire de Communauté',
    category: 'Commercialisation',
    endpoint: `${N8N_BASE_URL}/agent-gestionnaire-de-communaute`,
    description: 'Gérez et engagez votre communauté en ligne',
    fields: [
      { name: 'platform', type: 'select', label: 'Plateforme', required: true, options: [
        { value: 'instagram', label: 'Instagram' },
        { value: 'facebook', label: 'Facebook' },
        { value: 'twitter', label: 'Twitter/X' },
        { value: 'linkedin', label: 'LinkedIn' },
        { value: 'tiktok', label: 'TikTok' },
      ]},
      { name: 'comment', type: 'textarea', label: 'Commentaire à répondre', placeholder: 'Copier le commentaire ici...', required: true },
      { name: 'author', type: 'text', label: 'Auteur du commentaire', placeholder: '@utilisateur', required: false },
      { name: 'post_id', type: 'text', label: 'ID/URL du post', placeholder: 'https://...', required: false },
    ],
  },
  {
    slug: 'seo-dominator',
    name: 'Maître du SEO',
    category: 'Commercialisation',
    endpoint: `${N8N_BASE_URL}/agent-seo-dominator`,
    description: 'Optimisez votre contenu pour les moteurs de recherche',
    fields: [
      { name: 'topic', type: 'text', label: 'Sujet de l\'article', placeholder: 'Comment améliorer son SEO', required: true },
      { name: 'keywords', type: 'textarea', label: 'Mots-clés (un par ligne)', placeholder: 'seo\nréférencement\ngoogle', required: true },
      { name: 'length', type: 'select', label: 'Longueur de l\'article', required: true, options: [
        { value: 'short', label: 'Court (500 mots)' },
        { value: 'medium', label: 'Moyen (1000 mots)' },
        { value: 'long', label: 'Long (2000 mots)' },
        { value: 'very_long', label: 'Très long (3000+ mots)' },
      ]},
    ],
  },
  {
    slug: 'script-video-pro',
    name: 'Video Script Pro',
    category: 'Commercialisation',
    endpoint: `${N8N_BASE_URL}/agent-script-video-pro`,
    description: 'Créez des scripts vidéo captivants',
    fields: [
      { name: 'topic', type: 'text', label: 'Sujet de la vidéo', placeholder: '10 astuces productivité', required: true },
      { name: 'platform', type: 'select', label: 'Plateforme', required: true, options: [
        { value: 'youtube', label: 'YouTube' },
        { value: 'tiktok', label: 'TikTok' },
        { value: 'instagram', label: 'Instagram Reels' },
        { value: 'linkedin', label: 'LinkedIn' },
        { value: 'shorts', label: 'YouTube Shorts' },
      ]},
      { name: 'duration', type: 'select', label: 'Durée', required: true, options: [
        { value: '15s', label: '15 secondes' },
        { value: '30s', label: '30 secondes' },
        { value: '60s', label: '1 minute' },
        { value: '3min', label: '3 minutes' },
        { value: '10min', label: '10 minutes' },
        { value: '20min', label: '20+ minutes' },
      ]},
      { name: 'tone', type: 'select', label: 'Ton', required: true, options: [
        { value: 'professionnel', label: 'Professionnel' },
        { value: 'casual', label: 'Décontracté' },
        { value: 'humour', label: 'Humoristique' },
        { value: 'inspirant', label: 'Inspirant' },
        { value: 'educatif', label: 'Éducatif' },
      ]},
    ],
  },
  {
    slug: 'contenu-social',
    name: 'Contenu Social',
    category: 'Commercialisation',
    endpoint: `${N8N_BASE_URL}/agent-contenu-social`,
    description: 'Créez du contenu engageant pour les réseaux sociaux',
    fields: [
      { name: 'topic', type: 'text', label: 'Sujet/Thème', placeholder: 'Lancement produit', required: true },
      { name: 'platforms', type: 'multiselect', label: 'Plateformes', required: true, options: [
        { value: 'instagram', label: 'Instagram' },
        { value: 'facebook', label: 'Facebook' },
        { value: 'twitter', label: 'Twitter/X' },
        { value: 'linkedin', label: 'LinkedIn' },
        { value: 'tiktok', label: 'TikTok' },
      ]},
      { name: 'tone', type: 'select', label: 'Ton', required: true, options: [
        { value: 'professionnel', label: 'Professionnel' },
        { value: 'casual', label: 'Décontracté' },
        { value: 'humour', label: 'Humoristique' },
        { value: 'inspirant', label: 'Inspirant' },
      ]},
      { name: 'hashtags', type: 'boolean', label: 'Inclure des hashtags', required: false },
    ],
  },
  {
    slug: 'oracle-des-tendances',
    name: 'Oracle des Tendances',
    category: 'Commercialisation',
    endpoint: `${N8N_BASE_URL}/agent-oracle-des-tendances`,
    description: 'Analysez les tendances du marché',
    fields: [
      { name: 'industry', type: 'select', label: 'Industrie', required: true, options: [
        { value: 'tech', label: 'Technologie' },
        { value: 'fashion', label: 'Mode' },
        { value: 'food', label: 'Alimentation' },
        { value: 'health', label: 'Santé' },
        { value: 'finance', label: 'Finance' },
        { value: 'retail', label: 'Retail' },
        { value: 'saas', label: 'SaaS' },
      ]},
      { name: 'timeframe', type: 'select', label: 'Période', required: true, options: [
        { value: '1month', label: '1 mois' },
        { value: '3months', label: '3 mois' },
        { value: '6months', label: '6 mois' },
        { value: '1year', label: '1 an' },
      ]},
      { name: 'region', type: 'select', label: 'Région', required: false, options: [
        { value: 'france', label: 'France' },
        { value: 'europe', label: 'Europe' },
        { value: 'usa', label: 'États-Unis' },
        { value: 'global', label: 'Mondial' },
      ]},
    ],
  },
  {
    slug: 'espion-concurrent',
    name: 'Espion Concurrent',
    category: 'Commercialisation',
    endpoint: `${N8N_BASE_URL}/agent-espion-concurrent`,
    description: 'Analysez vos concurrents',
    fields: [
      { name: 'competitor', type: 'text', label: 'Nom du concurrent', placeholder: 'Entreprise XYZ', required: true },
      { name: 'url', type: 'text', label: 'Site web du concurrent', placeholder: 'https://concurrent.com', required: false },
      { name: 'metrics', type: 'multiselect', label: 'Métriques à analyser', required: true, options: [
        { value: 'pricing', label: 'Prix' },
        { value: 'features', label: 'Fonctionnalités' },
        { value: 'seo', label: 'SEO' },
        { value: 'social', label: 'Réseaux sociaux' },
        { value: 'reviews', label: 'Avis clients' },
        { value: 'traffic', label: 'Trafic web' },
      ]},
    ],
  },
];

// ==================== EMAIL (4 agents) ====================

const emailAgents: AgentConfig[] = [
  {
    slug: 'repondeur-intelligent',
    name: 'Répondeur Intelligent',
    category: 'Email',
    endpoint: `${N8N_BASE_URL}/agent-repondeur-intelligent`,
    description: 'Répondez automatiquement aux emails',
    fields: [
      { name: 'from', type: 'email', label: 'Email de l\'expéditeur', placeholder: 'expediteur@exemple.com', required: true },
      { name: 'subject', type: 'text', label: 'Sujet de l\'email', placeholder: 'Re: Votre demande', required: true },
      { name: 'body', type: 'textarea', label: 'Corps de l\'email reçu', placeholder: 'Contenu de l\'email...', required: true },
      { name: 'tone', type: 'select', label: 'Ton de la réponse', required: true, options: [
        { value: 'formel', label: 'Formel' },
        { value: 'professionnel', label: 'Professionnel' },
        { value: 'amical', label: 'Amical' },
        { value: 'concis', label: 'Concis' },
      ]},
    ],
  },
  {
    slug: 'campagnes-par-courriel',
    name: 'Campagnes par E-mail',
    category: 'Email',
    endpoint: `${N8N_BASE_URL}/agent-campagnes-par-courriel`,
    description: 'Créez des campagnes email performantes',
    fields: [
      { name: 'campaign_name', type: 'text', label: 'Nom de la campagne', placeholder: 'Promo Été 2024', required: true },
      { name: 'subject', type: 'text', label: 'Objet de l\'email', placeholder: '-50% sur tout le site !', required: true },
      { name: 'content', type: 'textarea', label: 'Contenu/Brief', placeholder: 'Décrivez le message principal...', required: true },
      { name: 'recipients', type: 'textarea', label: 'Destinataires (un email par ligne)', placeholder: 'email1@test.com\nemail2@test.com', required: false },
      { name: 'schedule', type: 'text', label: 'Date d\'envoi (optionnel)', placeholder: '2024-12-25 10:00', required: false },
    ],
  },
  {
    slug: 'pro-de-la-sensibilisation-au-froid',
    name: 'Pro de la Prospection à Froid',
    category: 'Email',
    endpoint: `${N8N_BASE_URL}/agent-pro-de-la-sensibilisation-au-froid`,
    description: 'Créez des emails de prospection efficaces',
    fields: [
      { name: 'name', type: 'text', label: 'Nom du prospect', placeholder: 'Jean Dupont', required: true },
      { name: 'email', type: 'email', label: 'Email du prospect', placeholder: 'jean@entreprise.com', required: true },
      { name: 'company', type: 'text', label: 'Entreprise', placeholder: 'Startup SAS', required: true },
      { name: 'pain_point', type: 'textarea', label: 'Point de douleur identifié', placeholder: 'Difficulté à gérer les leads...', required: true },
    ],
  },
  {
    slug: 'newsletter-genie',
    name: 'Newsletter Genius',
    category: 'Email',
    endpoint: `${N8N_BASE_URL}/agent-newsletter-genie`,
    description: 'Créez des newsletters engageantes',
    fields: [
      { name: 'topic', type: 'text', label: 'Thème de la newsletter', placeholder: 'Tendances tech du mois', required: true },
      { name: 'brand_name', type: 'text', label: 'Nom de la marque', placeholder: 'TechNews', required: true },
      { name: 'tone', type: 'select', label: 'Ton', required: true, options: [
        { value: 'informatif', label: 'Informatif' },
        { value: 'casual', label: 'Décontracté' },
        { value: 'expert', label: 'Expert' },
        { value: 'inspirant', label: 'Inspirant' },
      ]},
    ],
  },
];

// ==================== LEGAL (4 agents) ====================

const legalAgents: AgentConfig[] = [
  {
    slug: 'conseiller-juridique-ia',
    name: 'Conseiller Juridique IA',
    category: 'Légal',
    endpoint: `${N8N_BASE_URL}/agent-conseiller-juridique-ia`,
    description: 'Obtenez des conseils juridiques personnalisés',
    fields: [
      { name: 'question', type: 'textarea', label: 'Votre question juridique', placeholder: 'Décrivez votre situation...', required: true },
      { name: 'category', type: 'select', label: 'Catégorie', required: true, options: [
        { value: 'contrat', label: 'Contrats' },
        { value: 'travail', label: 'Droit du travail' },
        { value: 'societes', label: 'Droit des sociétés' },
        { value: 'propriete', label: 'Propriété intellectuelle' },
        { value: 'rgpd', label: 'RGPD/Données' },
        { value: 'fiscal', label: 'Fiscalité' },
        { value: 'autre', label: 'Autre' },
      ]},
      { name: 'context', type: 'textarea', label: 'Contexte (optionnel)', placeholder: 'Détails supplémentaires...', required: false },
    ],
  },
  {
    slug: 'mediateur',
    name: 'Résolveur de Litiges',
    category: 'Légal',
    endpoint: `${N8N_BASE_URL}/agent-mediateur`,
    description: 'Gérez vos litiges et conflits',
    fields: [
      { name: 'type', type: 'select', label: 'Type de litige', required: true, options: [
        { value: 'commercial', label: 'Commercial' },
        { value: 'emploi', label: 'Emploi' },
        { value: 'client', label: 'Client' },
        { value: 'fournisseur', label: 'Fournisseur' },
        { value: 'autre', label: 'Autre' },
      ]},
      { name: 'description', type: 'textarea', label: 'Description du litige', placeholder: 'Décrivez la situation...', required: true },
      { name: 'amount', type: 'number', label: 'Montant en jeu (€)', placeholder: '5000', required: false },
      { name: 'counterparty', type: 'text', label: 'Partie adverse', placeholder: 'Nom de l\'entreprise ou personne', required: true },
    ],
  },
  {
    slug: 'usine-sous-contrat',
    name: 'Usine sous Contrat',
    category: 'Légal',
    endpoint: `${N8N_BASE_URL}/agent-usine-sous-contrat`,
    description: 'Générez des contrats personnalisés',
    fields: [
      { name: 'type', type: 'select', label: 'Type de contrat', required: true, options: [
        { value: 'cgu', label: 'CGU (Conditions Générales d\'Utilisation)' },
        { value: 'cgv', label: 'CGV (Conditions Générales de Vente)' },
        { value: 'nda', label: 'NDA (Accord de confidentialité)' },
        { value: 'contrat_travail', label: 'Contrat de travail' },
        { value: 'prestation', label: 'Contrat de prestation' },
        { value: 'partenariat', label: 'Accord de partenariat' },
      ]},
      { name: 'company', type: 'text', label: 'Nom de l\'entreprise', placeholder: 'Ma Société SAS', required: true },
      { name: 'activity', type: 'text', label: 'Activité de l\'entreprise', placeholder: 'E-commerce, SaaS, Consulting...', required: true },
    ],
  },
  {
    slug: 'rgpd-guardian',
    name: 'Gardien du RGPD',
    category: 'Légal',
    endpoint: `${N8N_BASE_URL}/agent-rgpd-guardian`,
    description: 'Assurez votre conformité RGPD',
    fields: [
      { name: 'action', type: 'select', label: 'Action souhaitée', required: true, options: [
        { value: 'audit', label: 'Audit de conformité' },
        { value: 'politique', label: 'Générer politique de confidentialité' },
        { value: 'cookies', label: 'Générer politique cookies' },
        { value: 'registre', label: 'Créer registre des traitements' },
        { value: 'dpo', label: 'Conseil DPO' },
      ]},
      { name: 'company', type: 'text', label: 'Nom de l\'entreprise', placeholder: 'Ma Société', required: true },
      { name: 'website', type: 'text', label: 'Site web', placeholder: 'https://monsitecom', required: false },
    ],
  },
];

// ==================== ADMIN (4 agents) ====================

const adminAgents: AgentConfig[] = [
  {
    slug: 'remplisseur-de-formulaire',
    name: 'Remplissage de Formulaire',
    category: 'Admin',
    endpoint: `${N8N_BASE_URL}/agent-remplisseur-de-formulaire`,
    description: 'Remplissez automatiquement vos formulaires administratifs',
    fields: [
      { name: 'form_type', type: 'select', label: 'Type de formulaire', required: true, options: [
        { value: 'urssaf', label: 'URSSAF' },
        { value: 'impots', label: 'Impôts' },
        { value: 'kbis', label: 'Extrait Kbis' },
        { value: 'siret', label: 'SIRET/SIREN' },
        { value: 'autre', label: 'Autre' },
      ]},
      { name: 'company_name', type: 'text', label: 'Nom de l\'entreprise', placeholder: 'Ma Société', required: true },
      { name: 'siret', type: 'text', label: 'SIRET (14 chiffres)', placeholder: '12345678901234', required: false },
      { name: 'additional_info', type: 'textarea', label: 'Informations supplémentaires', placeholder: 'Autres données...', required: false },
    ],
  },
  {
    slug: 'assistant-administratif',
    name: 'Assistante Administrative',
    category: 'Admin',
    endpoint: `${N8N_BASE_URL}/agent-assistant-administratif`,
    description: 'Gérez vos tâches administratives',
    fields: [
      { name: 'task_type', type: 'select', label: 'Type de tâche', required: true, options: [
        { value: 'courrier', label: 'Rédiger un courrier' },
        { value: 'note', label: 'Note de service' },
        { value: 'compte_rendu', label: 'Compte-rendu' },
        { value: 'rappel', label: 'Rappel/Relance' },
        { value: 'autre', label: 'Autre' },
      ]},
      { name: 'description', type: 'textarea', label: 'Description de la tâche', placeholder: 'Détails...', required: true },
      { name: 'due_date', type: 'date', label: 'Date limite', required: false },
      { name: 'priority', type: 'select', label: 'Priorité', required: true, options: [
        { value: 'basse', label: 'Basse' },
        { value: 'normale', label: 'Normale' },
        { value: 'haute', label: 'Haute' },
        { value: 'urgente', label: 'Urgente' },
      ]},
    ],
  },
  {
    slug: 'organisateur-de-documents',
    name: 'Organiseur de Documents',
    category: 'Admin',
    endpoint: `${N8N_BASE_URL}/agent-organisateur-de-documents`,
    description: 'Organisez et classez vos documents',
    fields: [
      { name: 'filename', type: 'text', label: 'Nom du fichier', placeholder: 'facture_2024.pdf', required: true },
      { name: 'content', type: 'textarea', label: 'Description/Contenu', placeholder: 'De quoi parle ce document...', required: true },
      { name: 'file_type', type: 'select', label: 'Type de document', required: true, options: [
        { value: 'facture', label: 'Facture' },
        { value: 'contrat', label: 'Contrat' },
        { value: 'devis', label: 'Devis' },
        { value: 'rapport', label: 'Rapport' },
        { value: 'correspondance', label: 'Correspondance' },
        { value: 'autre', label: 'Autre' },
      ]},
    ],
  },
  {
    slug: 'gestionnaire-d-archives',
    name: 'Gestionnaire d\'Archives',
    category: 'Admin',
    endpoint: `${N8N_BASE_URL}/agent-gestionnaire-d-archives`,
    description: 'Gérez l\'archivage de vos documents',
    fields: [
      { name: 'action', type: 'select', label: 'Action', required: true, options: [
        { value: 'archiver', label: 'Archiver des documents' },
        { value: 'rechercher', label: 'Rechercher dans les archives' },
        { value: 'supprimer', label: 'Supprimer des archives' },
        { value: 'inventaire', label: 'Faire un inventaire' },
      ]},
      { name: 'retention', type: 'number', label: 'Durée de conservation (années)', placeholder: '5', required: false },
    ],
  },
];

// ==================== FINANCE (6 agents) ====================

const financeAgents: AgentConfig[] = [
  {
    slug: 'synchronisation-bancaire',
    name: 'Synchronisation Bancaire',
    category: 'Finance',
    endpoint: `${N8N_BASE_URL}/agent-synchronisation-bancaire`,
    description: 'Synchronisez vos comptes bancaires',
    fields: [
      { name: 'bank_id', type: 'text', label: 'ID de la banque', placeholder: 'BNP, SG, CA...', required: true },
      { name: 'account_id', type: 'text', label: 'Numéro de compte', placeholder: 'FRXX...', required: true },
      { name: 'date_from', type: 'date', label: 'Date de début', required: true },
      { name: 'date_to', type: 'date', label: 'Date de fin', required: true },
    ],
  },
  {
    slug: 'calculateur-d-impot',
    name: 'Calculateur d\'Impôt',
    category: 'Finance',
    endpoint: `${N8N_BASE_URL}/agent-calculateur-d-impot`,
    description: 'Calculez vos impôts facilement',
    fields: [
      { name: 'revenue', type: 'number', label: 'Chiffre d\'affaires (€)', placeholder: '100000', required: true },
      { name: 'expenses', type: 'number', label: 'Charges déductibles (€)', placeholder: '30000', required: true },
      { name: 'regime', type: 'select', label: 'Régime fiscal', required: true, options: [
        { value: 'micro', label: 'Micro-entreprise' },
        { value: 'reel_simplifie', label: 'Réel simplifié' },
        { value: 'reel_normal', label: 'Réel normal' },
        { value: 'is', label: 'Impôt sur les sociétés' },
      ]},
      { name: 'legal_form', type: 'select', label: 'Forme juridique', required: true, options: [
        { value: 'ei', label: 'Entreprise individuelle' },
        { value: 'eurl', label: 'EURL' },
        { value: 'sarl', label: 'SARL' },
        { value: 'sas', label: 'SAS' },
        { value: 'sasu', label: 'SASU' },
      ]},
    ],
  },
  {
    slug: 'suivi-des-depenses',
    name: 'Suivi des Dépenses',
    category: 'Finance',
    endpoint: `${N8N_BASE_URL}/agent-suivi-des-depenses`,
    description: 'Suivez et catégorisez vos dépenses',
    fields: [
      { name: 'description', type: 'text', label: 'Description', placeholder: 'Achat fournitures', required: true },
      { name: 'amount', type: 'number', label: 'Montant (€)', placeholder: '150.50', required: true },
      { name: 'date', type: 'date', label: 'Date', required: true },
      { name: 'vendor', type: 'text', label: 'Fournisseur', placeholder: 'Amazon', required: false },
    ],
  },
  {
    slug: 'chasseur-de-paiements',
    name: 'Chasseur de Paiements',
    category: 'Finance',
    endpoint: `${N8N_BASE_URL}/agent-chasseur-de-paiements`,
    description: 'Relancez les factures impayées',
    fields: [
      { name: 'invoice_id', type: 'text', label: 'Numéro de facture', placeholder: 'FAC-2024-001', required: true },
      { name: 'client_email', type: 'email', label: 'Email du client', placeholder: 'client@exemple.com', required: true },
      { name: 'amount', type: 'number', label: 'Montant (€)', placeholder: '1500', required: true },
      { name: 'due_date', type: 'date', label: 'Date d\'échéance', required: true },
      { name: 'days_overdue', type: 'number', label: 'Jours de retard', placeholder: '15', required: false },
    ],
  },
  {
    slug: 'rapports-financiers',
    name: 'Rapports Financiers',
    category: 'Finance',
    endpoint: `${N8N_BASE_URL}/agent-rapports-financiers`,
    description: 'Générez des rapports financiers',
    fields: [
      { name: 'type', type: 'select', label: 'Type de rapport', required: true, options: [
        { value: 'pnl', label: 'Compte de résultat (P&L)' },
        { value: 'balance', label: 'Bilan' },
        { value: 'cashflow', label: 'Flux de trésorerie' },
        { value: 'budget', label: 'Budget prévisionnel' },
      ]},
      { name: 'period', type: 'select', label: 'Période', required: true, options: [
        { value: 'month', label: 'Mois en cours' },
        { value: 'quarter', label: 'Trimestre' },
        { value: 'year', label: 'Année' },
        { value: 'custom', label: 'Personnalisé' },
      ]},
    ],
  },
  {
    slug: 'facture-pro',
    name: 'Facturation Pro',
    category: 'Finance',
    endpoint: `${N8N_BASE_URL}/agent-facture-pro`,
    description: 'Créez des factures professionnelles',
    fields: [
      { name: 'client_name', type: 'text', label: 'Nom du client', placeholder: 'Société XYZ', required: true },
      { name: 'email', type: 'email', label: 'Email du client', placeholder: 'facturation@client.com', required: true },
      { name: 'items', type: 'textarea', label: 'Lignes de facture (format: Description | Prix)', placeholder: 'Consultation 2h | 200\nDéveloppement | 500', required: true },
    ],
  },
];

// ==================== CHATBOT (5 agents) ====================

const chatbotAgents: AgentConfig[] = [
  {
    slug: 'bot-whatsapp',
    name: 'Bot WhatsApp Business',
    category: 'Chatbot',
    endpoint: `${N8N_BASE_URL}/agent-bot-whatsapp`,
    description: 'Automatisez vos conversations WhatsApp',
    fields: [
      { name: 'from', type: 'text', label: 'Numéro WhatsApp', placeholder: '+33612345678', required: true },
      { name: 'message', type: 'textarea', label: 'Message reçu', placeholder: 'Bonjour, je voudrais...', required: true },
      { name: 'business_id', type: 'text', label: 'ID Business (optionnel)', placeholder: 'WABA-123', required: false },
    ],
  },
  {
    slug: 'bot-de-messagerie',
    name: 'Bot Messenger',
    category: 'Chatbot',
    endpoint: `${N8N_BASE_URL}/agent-bot-de-messagerie`,
    description: 'Automatisez vos conversations Messenger',
    fields: [
      { name: 'sender_id', type: 'text', label: 'ID de l\'expéditeur', placeholder: 'PSI-123', required: true },
      { name: 'message', type: 'textarea', label: 'Message reçu', placeholder: 'Message...', required: true },
      { name: 'page_id', type: 'text', label: 'ID de la page', placeholder: 'PAGE-456', required: false },
    ],
  },
  {
    slug: 'chatbot-de-site-web',
    name: 'Chatbot de Site Web',
    category: 'Chatbot',
    endpoint: `${N8N_BASE_URL}/agent-chatbot-de-site-web`,
    description: 'Chatbot intelligent pour votre site',
    fields: [
      { name: 'visitor_id', type: 'text', label: 'ID du visiteur', placeholder: 'VIS-123', required: false },
      { name: 'message', type: 'textarea', label: 'Message du visiteur', placeholder: 'J\'ai une question sur...', required: true },
      { name: 'page_url', type: 'text', label: 'URL de la page', placeholder: 'https://monsite.com/page', required: false },
      { name: 'session_id', type: 'text', label: 'ID de session', placeholder: 'SES-456', required: false },
    ],
  },
  {
    slug: 'bot-telegram',
    name: 'Telegram Bot Pro',
    category: 'Chatbot',
    endpoint: `${N8N_BASE_URL}/agent-bot-telegram`,
    description: 'Automatisez vos conversations Telegram',
    fields: [
      { name: 'chat_id', type: 'text', label: 'ID du chat', placeholder: '123456789', required: true },
      { name: 'message', type: 'textarea', label: 'Message reçu', placeholder: 'Message...', required: true },
      { name: 'user_id', type: 'text', label: 'ID utilisateur Telegram', placeholder: 'TG-123', required: false },
    ],
  },
  {
    slug: 'bot-de-messagerie-instagram',
    name: 'Bot de Messagerie Instagram',
    category: 'Chatbot',
    endpoint: `${N8N_BASE_URL}/agent-bot-de-messagerie-instagram`,
    description: 'Automatisez vos DMs Instagram',
    fields: [
      { name: 'sender_id', type: 'text', label: 'ID de l\'expéditeur', placeholder: 'IG-123', required: true },
      { name: 'message', type: 'textarea', label: 'Message reçu', placeholder: 'Message...', required: true },
      { name: 'ig_id', type: 'text', label: 'ID Instagram Business', placeholder: 'IGBIZ-456', required: false },
    ],
  },
];

// ==================== SUPPORT (4 agents) ====================

const supportAgents: AgentConfig[] = [
  {
    slug: 'sav-247',
    name: 'SAV 24/7',
    category: 'Support',
    endpoint: `${N8N_BASE_URL}/agent-sav-247`,
    description: 'Service après-vente automatisé',
    fields: [
      { name: 'email', type: 'email', label: 'Email du client', placeholder: 'client@exemple.com', required: true },
      { name: 'issue', type: 'textarea', label: 'Description du problème', placeholder: 'Mon produit ne fonctionne pas...', required: true },
      { name: 'order_id', type: 'text', label: 'Numéro de commande', placeholder: 'CMD-2024-001', required: false },
    ],
  },
  {
    slug: 'maitre-des-billets',
    name: 'Ticket Master',
    category: 'Support',
    endpoint: `${N8N_BASE_URL}/agent-maitre-des-billets`,
    description: 'Gérez vos tickets de support',
    fields: [
      { name: 'subject', type: 'text', label: 'Sujet', placeholder: 'Problème de connexion', required: true },
      { name: 'description', type: 'textarea', label: 'Description', placeholder: 'Détails du problème...', required: true },
      { name: 'email', type: 'email', label: 'Email', placeholder: 'client@exemple.com', required: true },
      { name: 'priority', type: 'select', label: 'Priorité', required: true, options: [
        { value: 'low', label: 'Basse' },
        { value: 'medium', label: 'Moyenne' },
        { value: 'high', label: 'Haute' },
        { value: 'urgent', label: 'Urgente' },
      ]},
    ],
  },
  {
    slug: 'booster-de-critiques',
    name: 'Booster de Révision',
    category: 'Support',
    endpoint: `${N8N_BASE_URL}/agent-booster-de-critiques`,
    description: 'Obtenez plus d\'avis clients',
    fields: [
      { name: 'email', type: 'email', label: 'Email du client', placeholder: 'client@exemple.com', required: true },
      { name: 'name', type: 'text', label: 'Nom du client', placeholder: 'Jean Dupont', required: true },
      { name: 'order_id', type: 'text', label: 'Numéro de commande', placeholder: 'CMD-001', required: false },
      { name: 'platform', type: 'select', label: 'Plateforme d\'avis', required: true, options: [
        { value: 'google', label: 'Google' },
        { value: 'trustpilot', label: 'Trustpilot' },
        { value: 'facebook', label: 'Facebook' },
        { value: 'yelp', label: 'Yelp' },
        { value: 'autre', label: 'Autre' },
      ]},
    ],
  },
  {
    slug: 'faq-intelligente',
    name: 'FAQ Intelligent',
    category: 'Support',
    endpoint: `${N8N_BASE_URL}/agent-faq-intelligente`,
    description: 'Répondez automatiquement aux questions fréquentes',
    fields: [
      { name: 'question', type: 'textarea', label: 'Question du client', placeholder: 'Comment puis-je...', required: true },
      { name: 'category', type: 'select', label: 'Catégorie', required: false, options: [
        { value: 'produit', label: 'Produit' },
        { value: 'livraison', label: 'Livraison' },
        { value: 'paiement', label: 'Paiement' },
        { value: 'retour', label: 'Retour/Remboursement' },
        { value: 'compte', label: 'Compte' },
        { value: 'autre', label: 'Autre' },
      ]},
    ],
  },
];

// ==================== ANALYTIQUE (1 agent) ====================

const analyticsAgents: AgentConfig[] = [
  {
    slug: 'tableau-de-bord-analytique',
    name: 'Tableau de Bord Analytique',
    category: 'Analytique',
    endpoint: `${N8N_BASE_URL}/agent-tableau-de-bord-analytique`,
    description: 'Analysez vos données business',
    fields: [
      { name: 'period', type: 'select', label: 'Période', required: true, options: [
        { value: '7days', label: '7 derniers jours' },
        { value: '30days', label: '30 derniers jours' },
        { value: '90days', label: '90 derniers jours' },
        { value: 'year', label: 'Cette année' },
        { value: 'custom', label: 'Personnalisé' },
      ]},
      { name: 'metrics', type: 'multiselect', label: 'Métriques', required: true, options: [
        { value: 'revenue', label: 'Chiffre d\'affaires' },
        { value: 'orders', label: 'Commandes' },
        { value: 'customers', label: 'Clients' },
        { value: 'traffic', label: 'Trafic' },
        { value: 'conversion', label: 'Taux de conversion' },
        { value: 'aov', label: 'Panier moyen' },
      ]},
    ],
  },
];

// ==================== PRODUCTIVITÉ (2 agents) ====================

const productivityAgents: AgentConfig[] = [
  {
    slug: 'commandant-de-tache',
    name: 'Chef de Mission',
    category: 'Productivité',
    endpoint: `${N8N_BASE_URL}/agent-commandant-de-tache`,
    description: 'Gérez vos tâches efficacement',
    fields: [
      { name: 'description', type: 'textarea', label: 'Description de la tâche', placeholder: 'Préparer la présentation client...', required: true },
      { name: 'priority', type: 'select', label: 'Priorité', required: true, options: [
        { value: 'low', label: 'Basse' },
        { value: 'medium', label: 'Moyenne' },
        { value: 'high', label: 'Haute' },
        { value: 'critical', label: 'Critique' },
      ]},
      { name: 'due_date', type: 'date', label: 'Date limite', required: false },
      { name: 'assignee', type: 'text', label: 'Assigné à', placeholder: 'Jean Dupont', required: false },
    ],
  },
  {
    slug: 'reservation-intelligente',
    name: 'Réservation Intelligente',
    category: 'Productivité',
    endpoint: `${N8N_BASE_URL}/agent-reservation-intelligente`,
    description: 'Gérez vos réservations automatiquement',
    fields: [
      { name: 'client_name', type: 'text', label: 'Nom du client', placeholder: 'Marie Martin', required: true },
      { name: 'email', type: 'email', label: 'Email', placeholder: 'marie@exemple.com', required: true },
      { name: 'service', type: 'text', label: 'Service demandé', placeholder: 'Consultation 1h', required: true },
      { name: 'date', type: 'date', label: 'Date souhaitée', required: true },
      { name: 'time', type: 'time', label: 'Heure souhaitée', required: true },
    ],
  },
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
