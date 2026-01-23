-- Table pour la base de connaissances du chatbot
CREATE TABLE public.chatbot_knowledge (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  question TEXT NOT NULL,
  reponse TEXT NOT NULL,
  categorie TEXT NOT NULL,
  keywords TEXT[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Table pour les conversations
CREATE TABLE public.chat_conversations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  escalated BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Table pour les messages
CREATE TABLE public.chat_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.chatbot_knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- Knowledge base: public read, admin write
CREATE POLICY "Anyone can read knowledge base"
  ON public.chatbot_knowledge FOR SELECT
  USING (true);

CREATE POLICY "Admins can manage knowledge base"
  ON public.chatbot_knowledge FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Conversations: users can view/insert their own, anonymous by session
CREATE POLICY "Users can view own conversations"
  ON public.chat_conversations FOR SELECT
  USING (user_id = auth.uid() OR (user_id IS NULL AND session_id IS NOT NULL));

CREATE POLICY "Anyone can create conversations"
  ON public.chat_conversations FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Users can update own conversations"
  ON public.chat_conversations FOR UPDATE
  USING (user_id = auth.uid() OR user_id IS NULL);

-- Messages: linked to conversations
CREATE POLICY "Users can view messages of their conversations"
  ON public.chat_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id = chat_messages.conversation_id
      AND (c.user_id = auth.uid() OR c.user_id IS NULL)
    )
  );

CREATE POLICY "Anyone can insert messages"
  ON public.chat_messages FOR INSERT
  WITH CHECK (true);

-- Indexes for performance
CREATE INDEX idx_chat_conversations_user_id ON public.chat_conversations(user_id);
CREATE INDEX idx_chat_conversations_session_id ON public.chat_conversations(session_id);
CREATE INDEX idx_chat_messages_conversation_id ON public.chat_messages(conversation_id);
CREATE INDEX idx_chatbot_knowledge_keywords ON public.chatbot_knowledge USING GIN(keywords);
CREATE INDEX idx_chatbot_knowledge_categorie ON public.chatbot_knowledge(categorie);

-- Trigger for updated_at
CREATE TRIGGER update_chatbot_knowledge_updated_at
  BEFORE UPDATE ON public.chatbot_knowledge
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_chat_conversations_updated_at
  BEFORE UPDATE ON public.chat_conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Insert 50+ knowledge base entries
INSERT INTO public.chatbot_knowledge (question, reponse, categorie, keywords) VALUES
-- Général
('Qu''est-ce que Purama ?', 'Purama est une plateforme d''agents IA spécialisés qui automatisent vos tâches professionnelles. Nous proposons 45 agents IA couvrant le marketing, la vente, la finance, les RH et bien plus encore. Chaque agent est conçu pour vous faire gagner du temps et optimiser vos processus métier.', 'general', ARRAY['purama', 'agentia', 'plateforme', 'agents', 'ia', 'présentation']),
('Comment fonctionne Purama ?', 'Purama fonctionne en 3 étapes simples : 1) Choisissez vos agents IA parmi nos 45 spécialistes, 2) Connectez vos outils (Gmail, Google Calendar...), 3) Laissez les agents travailler pour vous 24/7. Vous pouvez suivre toutes les actions depuis votre tableau de bord.', 'general', ARRAY['fonctionnement', 'utilisation', 'comment', 'marche', 'étapes']),
('Quels sont les avantages de Purama ?', 'Les avantages de Purama incluent : gain de temps considérable (jusqu''à 80%), automatisation 24/7, 45 agents IA spécialisés, intégration avec vos outils existants, tableau de bord centralisé, support client réactif, et des prix accessibles à partir de 33€/mois.', 'general', ARRAY['avantages', 'bénéfices', 'pourquoi', 'intérêt']),

-- Tarifs
('Quels sont les tarifs de Purama ?', 'Nous proposons 2 formules : **Starter à 33€/mois** (3 agents, fonctionnalités de base, support email) et **Premium à 99€/mois** (agents illimités, fonctionnalités avancées, support prioritaire). Des réductions de 20% sont disponibles sur les abonnements annuels !', 'tarifs', ARRAY['prix', 'tarifs', 'coût', 'abonnement', 'formule', 'plan', 'offre']),
('Quelle est la différence entre Starter et Premium ?', 'Le plan **Starter (33€/mois)** inclut 3 agents IA, les fonctionnalités de base et le support email. Le plan **Premium (99€/mois)** offre un accès illimité à tous les 45 agents, des fonctionnalités avancées, la personnalisation et un support prioritaire 24/7.', 'tarifs', ARRAY['différence', 'starter', 'premium', 'comparaison', 'plans']),
('Y a-t-il un essai gratuit ?', 'Oui ! Vous pouvez tester Purama gratuitement. Créez votre compte et découvrez nos agents IA sans engagement. Vous pourrez ensuite choisir la formule qui vous convient le mieux.', 'tarifs', ARRAY['essai', 'gratuit', 'test', 'démo', 'free', 'trial']),
('Y a-t-il des réductions pour l''abonnement annuel ?', 'Absolument ! En choisissant l''abonnement annuel, vous bénéficiez de **20% de réduction**. Le Starter passe à 26,40€/mois et le Premium à 79,20€/mois, soit une économie significative sur l''année.', 'tarifs', ARRAY['réduction', 'annuel', 'promo', 'économie', 'remise']),
('Comment annuler mon abonnement ?', 'Vous pouvez annuler votre abonnement à tout moment depuis votre tableau de bord, section "Abonnement". L''annulation prend effet à la fin de votre période de facturation en cours. Vous conservez l''accès jusqu''à cette date.', 'tarifs', ARRAY['annuler', 'résilier', 'arrêter', 'abonnement']),
('Quels moyens de paiement acceptez-vous ?', 'Nous acceptons les cartes bancaires (Visa, Mastercard, American Express), les paiements via Stripe, et le prélèvement SEPA pour les abonnements. Toutes les transactions sont sécurisées et cryptées.', 'tarifs', ARRAY['paiement', 'carte', 'payer', 'moyen']),

-- Agents IA
('Combien d''agents IA proposez-vous ?', 'Purama propose **45 agents IA spécialisés** couvrant tous les domaines métier : Marketing, Ventes, Finance, RH, Productivité, Création de contenu, Analyse de données, Support client, et bien plus encore !', 'agents', ARRAY['combien', 'agents', 'nombre', 'liste']),
('Quels types d''agents IA sont disponibles ?', 'Nos agents couvrent : **Marketing** (réseaux sociaux, emails, SEO), **Ventes** (prospection, CRM, devis), **Finance** (facturation, comptabilité), **RH** (recrutement, onboarding), **Productivité** (agenda, tâches), et **Création** (rédaction, design, vidéo).', 'agents', ARRAY['types', 'catégories', 'domaines', 'agents']),
('Comment choisir le bon agent IA ?', 'Pour choisir le bon agent, identifiez d''abord vos besoins principaux. Consultez notre catalogue d''agents par catégorie, lisez les descriptions et fonctionnalités. Vous pouvez aussi me décrire votre besoin et je vous recommanderai les agents adaptés !', 'agents', ARRAY['choisir', 'quel', 'agent', 'recommandation', 'conseil']),
('Les agents peuvent-ils travailler ensemble ?', 'Oui ! Nos agents peuvent collaborer pour des workflows automatisés. Par exemple, l''agent Marketing peut créer du contenu que l''agent Social Media publie automatiquement. Ces intégrations sont disponibles avec le plan Premium.', 'agents', ARRAY['ensemble', 'collaboration', 'workflow', 'automatisation']),
('Puis-je personnaliser les agents ?', 'Avec le plan Premium, vous pouvez personnaliser les agents : ton de communication, préférences, règles métier spécifiques. Les agents apprennent de vos retours pour s''améliorer continuellement.', 'agents', ARRAY['personnaliser', 'configurer', 'adapter', 'custom']),

-- Connexions / Intégrations
('Comment connecter mon compte Google ?', 'Pour connecter Google : 1) Allez dans votre tableau de bord > Connexions, 2) Cliquez sur "Connecter Google", 3) Autorisez l''accès à Gmail et Calendar. Vos agents pourront alors gérer vos emails et votre agenda automatiquement.', 'connexions', ARRAY['google', 'connecter', 'gmail', 'calendar', 'intégration']),
('Quelles intégrations sont disponibles ?', 'Purama s''intègre avec : **Google** (Gmail, Calendar, Drive), **Microsoft** (Outlook, Teams), les **CRM** populaires (Salesforce, HubSpot), les outils **Marketing** (Mailchimp, Sendinblue), et bien d''autres. De nouvelles intégrations sont ajoutées régulièrement.', 'connexions', ARRAY['intégrations', 'outils', 'applications', 'connecter']),
('Mes données sont-elles sécurisées ?', 'Absolument ! Vos données sont cryptées en transit et au repos. Nous utilisons les protocoles OAuth2 pour les connexions tierces, ne stockons jamais vos mots de passe, et sommes conformes au RGPD. Vos données vous appartiennent et peuvent être exportées à tout moment.', 'connexions', ARRAY['sécurité', 'données', 'confidentialité', 'rgpd', 'protection']),
('Comment déconnecter une intégration ?', 'Pour déconnecter une intégration : tableau de bord > Connexions > cliquez sur l''intégration concernée > "Déconnecter". L''agent associé ne pourra plus accéder à ce service, mais vos données restent intactes.', 'connexions', ARRAY['déconnecter', 'supprimer', 'retirer', 'intégration']),

-- Programme influenceur/affiliation
('Comment fonctionne le programme d''affiliation ?', 'Notre programme d''affiliation offre : **-50% sur la 1ère année** pour vos abonnés, et des **commissions jusqu''à 33%** pour vous ! Commencez à 9.99% (Bronze), évoluez vers 19.99% (Silver) puis 33% (Gold) selon vos performances.', 'affiliation', ARRAY['affiliation', 'influenceur', 'parrainage', 'commission']),
('Quels sont les paliers de commission ?', 'Notre système de paliers : **Bronze** (0-19 ventes) = 9.99% de commission, **Silver** (20-49 ventes) = 19.99%, **Gold** (50+ ventes) = 33% ! Plus vous performez, plus vous gagnez. Les paliers sont automatiquement mis à jour.', 'affiliation', ARRAY['paliers', 'tiers', 'commission', 'bronze', 'silver', 'gold']),
('Comment devenir influenceur Purama ?', 'Pour devenir influenceur : 1) Créez votre compte sur Purama, 2) Allez dans "Espace Influenceur", 3) Remplissez vos informations, 4) Signez le contrat digital. Vous recevrez immédiatement votre lien d''affiliation unique et votre code promo !', 'affiliation', ARRAY['devenir', 'influenceur', 'inscription', 'affilié']),
('Comment sont payées les commissions ?', 'Les commissions sont payées mensuellement par virement bancaire. Le seuil minimum est de 50€. Vous pouvez suivre vos gains en temps réel depuis votre tableau de bord influenceur et renseigner vos coordonnées bancaires (IBAN).', 'affiliation', ARRAY['paiement', 'commission', 'virement', 'gains']),
('Mon lien d''affiliation a-t-il une durée de validité ?', 'Votre lien d''affiliation est valable **1 mois**. Passé ce délai, vous pouvez le renouveler en un clic depuis votre tableau de bord. Les conversions restent trackées pendant 30 jours après le clic sur votre lien.', 'affiliation', ARRAY['durée', 'validité', 'expiration', 'lien']),

-- Support technique
('Je n''arrive pas à me connecter', 'Si vous avez des problèmes de connexion : 1) Vérifiez votre email et mot de passe, 2) Utilisez "Mot de passe oublié" si besoin, 3) Videz le cache de votre navigateur, 4) Essayez en navigation privée. Si le problème persiste, contactez notre support !', 'support', ARRAY['connexion', 'problème', 'login', 'accès', 'erreur']),
('Mon agent ne fonctionne pas', 'Si un agent ne fonctionne pas : 1) Vérifiez que les connexions nécessaires sont actives (Gmail, etc.), 2) Rafraîchissez la page, 3) Vérifiez votre abonnement. Si le problème persiste, notez le nom de l''agent et l''erreur affichée, puis contactez-nous !', 'support', ARRAY['agent', 'problème', 'bug', 'erreur', 'marche pas']),
('Comment contacter le support ?', 'Vous pouvez contacter notre support : 1) Via ce chat (je réponds 24/7 !), 2) Par email à support@purama.fr, 3) Via le formulaire de contact sur notre site. Le support Premium bénéficie d''une priorité de traitement.', 'support', ARRAY['contact', 'support', 'aide', 'assistance', 'email']),
('Où trouver mes factures ?', 'Vos factures sont disponibles dans votre tableau de bord > section "Facturation". Vous pouvez les télécharger en PDF et les recevoir automatiquement par email après chaque paiement.', 'support', ARRAY['facture', 'reçu', 'paiement', 'historique']),

-- Fonctionnalités avancées
('Comment programmer des tâches automatiques ?', 'Pour programmer des tâches : tableau de bord > Agents > Sélectionnez un agent > "Automatisations". Définissez la fréquence (quotidien, hebdomadaire...), les conditions de déclenchement, et les actions. Les tâches s''exécuteront automatiquement !', 'fonctionnalites', ARRAY['programmer', 'automatique', 'tâches', 'planifier', 'schedule']),
('Comment voir l''historique des actions de mes agents ?', 'L''historique est visible dans votre tableau de bord > "Activité". Vous y trouverez toutes les actions réalisées par vos agents, avec date, heure, détails et statut. Vous pouvez filtrer par agent ou par type d''action.', 'fonctionnalites', ARRAY['historique', 'actions', 'logs', 'activité']),
('Puis-je exporter mes données ?', 'Oui ! Allez dans Paramètres > "Mes données" > "Exporter". Vous pouvez exporter vos conversations, rapports d''activité, et données personnelles au format CSV ou JSON. C''est conforme au RGPD.', 'fonctionnalites', ARRAY['exporter', 'données', 'télécharger', 'backup']),
('Comment fonctionne le tableau de bord ?', 'Le tableau de bord centralise tout : vue d''ensemble de vos agents actifs, statistiques de performance, notifications, dernières actions, et accès rapide à toutes les fonctionnalités. Il se personnalise selon vos préférences.', 'fonctionnalites', ARRAY['tableau de bord', 'dashboard', 'interface', 'accueil']),

-- FAQ diverses
('Purama fonctionne-t-il sur mobile ?', 'Oui ! Purama est entièrement responsive et fonctionne parfaitement sur mobile, tablette et desktop. Vous pouvez gérer vos agents et suivre leurs actions où que vous soyez.', 'general', ARRAY['mobile', 'téléphone', 'tablette', 'responsive']),
('Dans quelles langues est disponible Purama ?', 'Purama est actuellement disponible en **français**. L''interface et les agents communiquent en français. L''ajout d''autres langues (anglais, espagnol, allemand) est prévu dans les prochains mois.', 'general', ARRAY['langue', 'français', 'anglais', 'traduction']),
('Puis-je utiliser Purama pour mon équipe ?', 'Absolument ! Le plan Premium permet d''ajouter des membres d''équipe avec différents niveaux d''accès. Chaque membre peut utiliser les agents et vous gardez un contrôle centralisé sur les activités.', 'general', ARRAY['équipe', 'team', 'collaborateurs', 'entreprise']),
('Y a-t-il une API disponible ?', 'Une API est en cours de développement pour les utilisateurs Premium. Elle permettra d''intégrer les agents Purama directement dans vos propres applications et workflows. Contactez-nous pour être informé de sa disponibilité.', 'general', ARRAY['api', 'développeur', 'intégration', 'webhook']),
('Comment Purama utilise-t-il l''IA ?', 'Purama utilise des modèles d''IA de pointe (GPT, Claude) pour alimenter ses agents. Chaque agent est entraîné et optimisé pour sa spécialité, garantissant des réponses pertinentes et des actions précises adaptées à votre contexte métier.', 'general', ARRAY['ia', 'intelligence artificielle', 'technologie', 'gpt', 'claude']),

-- Questions complémentaires
('Que se passe-t-il si je dépasse les limites de mon plan ?', 'Si vous atteignez les limites du plan Starter (3 agents), vous serez invité à passer au Premium pour un accès illimité. Vous ne perdrez aucune donnée et la transition est immédiate.', 'tarifs', ARRAY['limite', 'dépasser', 'upgrade', 'plan']),
('Puis-je changer de plan à tout moment ?', 'Oui ! Vous pouvez passer de Starter à Premium à tout moment. Le changement est proratisé : vous ne payez que la différence pour le reste de votre période. Le downgrade prend effet au renouvellement suivant.', 'tarifs', ARRAY['changer', 'plan', 'upgrade', 'downgrade']),
('Comment fonctionne le remboursement ?', 'Si vous n''êtes pas satisfait, contactez-nous dans les 14 jours suivant votre abonnement pour un remboursement complet. Au-delà, les remboursements sont étudiés au cas par cas par notre équipe.', 'tarifs', ARRAY['remboursement', 'satisfait', 'garantie']),
('Quels sont les agents les plus populaires ?', 'Les agents les plus utilisés sont : l''**Agent Email** (gestion automatique de la boîte mail), l''**Agent Social Media** (planification de posts), l''**Agent Assistant** (organisation du planning), et l''**Agent Rédacteur** (création de contenu).', 'agents', ARRAY['populaire', 'meilleur', 'utilisé', 'recommandé']),
('Comment les agents apprennent-ils de mes préférences ?', 'Les agents utilisent le machine learning pour s''améliorer. Plus vous les utilisez et leur donnez de feedback (approuver/refuser des suggestions), plus ils deviennent précis et adaptés à vos besoins spécifiques.', 'agents', ARRAY['apprendre', 'améliorer', 'feedback', 'personnalisation']),
('Puis-je suggérer un nouvel agent ?', 'Bien sûr ! Nous adorons les suggestions de notre communauté. Contactez-nous via le formulaire de contact avec votre idée d''agent. Les suggestions les plus demandées sont priorisées dans notre roadmap.', 'agents', ARRAY['suggestion', 'idée', 'nouvel', 'agent', 'fonctionnalité']),
('Comment réinitialiser mon mot de passe ?', 'Pour réinitialiser votre mot de passe : 1) Allez sur la page de connexion, 2) Cliquez sur "Mot de passe oublié", 3) Entrez votre email, 4) Vous recevrez un lien de réinitialisation. Le lien est valable 1 heure.', 'support', ARRAY['mot de passe', 'réinitialiser', 'oublié', 'password']),
('Comment supprimer mon compte ?', 'Pour supprimer votre compte : Paramètres > "Mon compte" > "Supprimer le compte". Attention : cette action est irréversible et supprimera toutes vos données. Vous pouvez d''abord exporter vos données si besoin.', 'support', ARRAY['supprimer', 'compte', 'effacer', 'clôturer']),
('Les notifications sont-elles personnalisables ?', 'Oui ! Dans Paramètres > Notifications, vous pouvez choisir de recevoir des alertes par email et/ou dans l''app pour : tâches terminées, questions des agents, rapports quotidiens, et alertes importantes.', 'fonctionnalites', ARRAY['notifications', 'alertes', 'email', 'personnaliser']),
('Comment voir les statistiques de mes agents ?', 'Les statistiques sont dans votre tableau de bord > "Analytics". Vous y trouverez : nombre de tâches réalisées, temps économisé, taux de réussite, et graphiques d''évolution. Les rapports sont exportables en PDF.', 'fonctionnalites', ARRAY['statistiques', 'analytics', 'rapports', 'performance']),
('Qu''est-ce que le mode premium des agents ?', 'Le mode Premium débloque des fonctionnalités avancées pour chaque agent : personnalisation poussée, intégrations étendues, automatisations complexes, et priorité de traitement. Disponible avec l''abonnement Premium.', 'fonctionnalites', ARRAY['premium', 'avancé', 'fonctionnalités', 'mode']);