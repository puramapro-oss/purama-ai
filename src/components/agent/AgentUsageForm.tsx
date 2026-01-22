import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate, Link } from 'react-router-dom';
import { 
  Rocket, 
  Loader2, 
  Mail, 
  Building2, 
  FileText,
  Send,
  Crown,
  AlertCircle,
  CheckCircle2,
  Headphones,
  AlertTriangle,
  Zap,
  Plus
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/hooks/useAuth';
import { useSubscription } from '@/hooks/useSubscription';
import { useAgentSelections } from '@/hooks/useAgentSelections';
import { toast } from 'sonner';

interface Agent {
  id: string;
  name: string;
  slug: string;
  category: string;
  is_premium: boolean;
  color?: string | null;
}

interface AgentUsageFormProps {
  agent: Agent;
}

interface FormData {
  // Legal fields
  file?: File;
  // Email fields
  recipient?: string;
  subject?: string;
  emailContent?: string;
  // Marketing fields
  brandName?: string;
  platform?: string;
  description?: string;
  // Support fields
  problemDescription?: string;
  urgencyLevel?: string;
  contactEmail?: string;
  // Generic field
  prompt?: string;
}

export function AgentUsageForm({ agent }: AgentUsageFormProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { hasSubscription, isStarter, isPremium, isLoading: subLoading } = useSubscription();
  const { hasAgent, addAgent, remainingSlots, isLoading: selectionsLoading } = useAgentSelections();
  
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState<FormData>({});
  const [result, setResult] = useState<string | null>(null);
  const [showResultModal, setShowResultModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingAgent, setAddingAgent] = useState(false);

  const category = agent.category?.toLowerCase() || '';
  
  // Determine access
  const isAgentInSelection = hasAgent(agent.id);
  const canUse = isPremium || (isStarter && isAgentInSelection);
  const canAddToSelection = isStarter && !isAgentInSelection && remainingSlots > 0;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setFormData(prev => ({ ...prev, file }));
    }
  };

  const handleInputChange = (field: keyof FormData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setError(null);
  };

  const handleAddToSelection = async () => {
    setAddingAgent(true);
    const success = await addAgent(agent.id);
    setAddingAgent(false);
    if (success) {
      toast.success('Agent ajouté !', {
        description: 'Vous pouvez maintenant utiliser cet agent.',
      });
    }
  };

  const validateForm = (): boolean => {
    if (category.includes('legal') || category.includes('juridique')) {
      if (!formData.file) {
        setError('Veuillez uploader un fichier contrat');
        return false;
      }
    } else if (category.includes('email') || category.includes('mail')) {
      if (!formData.recipient || !formData.subject || !formData.emailContent) {
        setError('Veuillez remplir tous les champs email');
        return false;
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(formData.recipient)) {
        setError('Adresse email invalide');
        return false;
      }
    } else if (category.includes('marketing')) {
      if (!formData.brandName || !formData.platform || !formData.description) {
        setError('Veuillez remplir tous les champs marketing');
        return false;
      }
    } else if (category.includes('support')) {
      if (!formData.problemDescription || !formData.urgencyLevel || !formData.contactEmail) {
        setError('Veuillez remplir tous les champs du formulaire');
        return false;
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(formData.contactEmail)) {
        setError('Adresse email de contact invalide');
        return false;
      }
    } else {
      if (!formData.prompt) {
        setError('Veuillez entrer une instruction');
        return false;
      }
    }
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!user) {
      toast.error('Connexion requise', {
        description: 'Veuillez vous connecter pour utiliser cet agent.',
      });
      navigate('/login');
      return;
    }

    // BYPASSED FOR TESTING
    // if (!canUse) {
    //   toast.error('Accès refusé', {
    //     description: 'Vous n\'avez pas accès à cet agent.',
    //   });
    //   return;
    // }

    if (!validateForm()) {
      return;
    }

    setIsLoading(true);

    try {
      const webhookUrl = `https://n8n.srv1286148.hstgr.cloud/webhook/agent-${agent.slug}`;
      
      let payload: Record<string, unknown> = {
        agentId: agent.id,
        agentName: agent.name,
        agentSlug: agent.slug,
        userId: user.id,
        userEmail: user.email,
        timestamp: new Date().toISOString(),
      };

      if (category.includes('legal') || category.includes('juridique')) {
        const formDataPayload = new FormData();
        formDataPayload.append('agentId', agent.id);
        formDataPayload.append('agentName', agent.name);
        formDataPayload.append('agentSlug', agent.slug);
        formDataPayload.append('userId', user.id);
        formDataPayload.append('userEmail', user.email || '');
        formDataPayload.append('timestamp', new Date().toISOString());
        if (formData.file) {
          formDataPayload.append('file', formData.file);
        }

        const response = await fetch(webhookUrl, {
          method: 'POST',
          body: formDataPayload,
        });

        if (!response.ok) {
          throw new Error(`Erreur ${response.status}`);
        }

        const resultData = await response.text();
        setResult(resultData || 'Contrat analysé avec succès !');
      } else {
        if (category.includes('email') || category.includes('mail')) {
          payload = {
            ...payload,
            recipient: formData.recipient,
            subject: formData.subject,
            content: formData.emailContent,
          };
        } else if (category.includes('marketing')) {
          payload = {
            ...payload,
            brandName: formData.brandName,
            platform: formData.platform,
            description: formData.description,
          };
        } else if (category.includes('support')) {
          payload = {
            ...payload,
            problemDescription: formData.problemDescription,
            urgencyLevel: formData.urgencyLevel,
            contactEmail: formData.contactEmail,
          };
        } else {
          payload = {
            ...payload,
            prompt: formData.prompt,
          };
        }

        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(`Erreur ${response.status}`);
        }

        const resultData = await response.text();
        setResult(resultData || 'Tâche exécutée avec succès !');
      }

      setShowResultModal(true);
      toast.success('Agent exécuté avec succès !');
    } catch (err) {
      console.error('Agent execution error:', err);
      setError('Une erreur est survenue lors de l\'exécution de l\'agent. Veuillez réessayer.');
      toast.error('Erreur d\'exécution', {
        description: 'Impossible de contacter l\'agent. Veuillez réessayer.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const renderFormFields = () => {
    if (category.includes('legal') || category.includes('juridique')) {
      return (
        <div className="space-y-4">
          <div>
            <Label htmlFor="contract-file" className="flex items-center gap-2 mb-2">
              <FileText className="w-4 h-4" />
              Contrat à analyser
            </Label>
            <div className="relative">
              <Input
                id="contract-file"
                type="file"
                accept=".pdf,.doc,.docx,.txt"
                onChange={handleFileChange}
                className="cursor-pointer file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90"
              />
              {formData.file && (
                <p className="text-sm text-muted-foreground mt-2">
                  Fichier sélectionné: {formData.file.name}
                </p>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (category.includes('email') || category.includes('mail')) {
      return (
        <div className="space-y-4">
          <div>
            <Label htmlFor="recipient" className="flex items-center gap-2 mb-2">
              <Mail className="w-4 h-4" />
              Destinataire
            </Label>
            <Input
              id="recipient"
              type="email"
              placeholder="exemple@email.com"
              value={formData.recipient || ''}
              onChange={(e) => handleInputChange('recipient', e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="subject" className="mb-2 block">Sujet</Label>
            <Input
              id="subject"
              type="text"
              placeholder="Sujet de l'email"
              value={formData.subject || ''}
              onChange={(e) => handleInputChange('subject', e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="email-content" className="mb-2 block">Contenu</Label>
            <Textarea
              id="email-content"
              placeholder="Décrivez le contenu de l'email à générer..."
              rows={4}
              value={formData.emailContent || ''}
              onChange={(e) => handleInputChange('emailContent', e.target.value)}
            />
          </div>
        </div>
      );
    }

    if (category.includes('marketing')) {
      return (
        <div className="space-y-4">
          <div>
            <Label htmlFor="brand-name" className="flex items-center gap-2 mb-2">
              <Building2 className="w-4 h-4" />
              Nom de la marque
            </Label>
            <Input
              id="brand-name"
              type="text"
              placeholder="Votre marque"
              value={formData.brandName || ''}
              onChange={(e) => handleInputChange('brandName', e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="platform" className="mb-2 block">Plateforme cible</Label>
            <Input
              id="platform"
              type="text"
              placeholder="Instagram, LinkedIn, TikTok..."
              value={formData.platform || ''}
              onChange={(e) => handleInputChange('platform', e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="description" className="mb-2 block">Description du contenu</Label>
            <Textarea
              id="description"
              placeholder="Décrivez le contenu marketing que vous souhaitez créer..."
              rows={4}
              value={formData.description || ''}
              onChange={(e) => handleInputChange('description', e.target.value)}
            />
          </div>
        </div>
      );
    }

    if (category.includes('support')) {
      return (
        <div className="space-y-4">
          <div>
            <Label htmlFor="problem-description" className="flex items-center gap-2 mb-2">
              <Headphones className="w-4 h-4" />
              Description du problème
            </Label>
            <Textarea
              id="problem-description"
              placeholder="Décrivez le problème rencontré en détail..."
              rows={4}
              value={formData.problemDescription || ''}
              onChange={(e) => handleInputChange('problemDescription', e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="urgency-level" className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4" />
              Niveau d'urgence
            </Label>
            <Select
              value={formData.urgencyLevel || ''}
              onValueChange={(value) => handleInputChange('urgencyLevel', value)}
            >
              <SelectTrigger id="urgency-level">
                <SelectValue placeholder="Sélectionnez le niveau d'urgence" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="faible">Faible</SelectItem>
                <SelectItem value="moyen">Moyen</SelectItem>
                <SelectItem value="eleve">Élevé</SelectItem>
                <SelectItem value="critique">Critique</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="contact-email" className="flex items-center gap-2 mb-2">
              <Mail className="w-4 h-4" />
              Email de contact
            </Label>
            <Input
              id="contact-email"
              type="email"
              placeholder="votre@email.com"
              value={formData.contactEmail || ''}
              onChange={(e) => handleInputChange('contactEmail', e.target.value)}
            />
          </div>
        </div>
      );
    }

    // Default/generic form
    return (
      <div className="space-y-4">
        <div>
          <Label htmlFor="prompt" className="flex items-center gap-2 mb-2">
            <Send className="w-4 h-4" />
            Instruction pour l'agent
          </Label>
          <Textarea
            id="prompt"
            placeholder="Décrivez ce que vous souhaitez que l'agent accomplisse..."
            rows={4}
            value={formData.prompt || ''}
            onChange={(e) => handleInputChange('prompt', e.target.value)}
          />
        </div>
      </div>
    );
  };

  // TEMPORARY BYPASS: Skip all subscription checks for testing
  // TODO: Remove this bypass and uncomment the subscription checks below when ready
  const bypassSubscriptionCheck = true;

  // Loading state - bypassed for testing
  // if (subLoading || selectionsLoading) {
  //   return (
  //     <motion.div
  //       initial={{ opacity: 0, y: 20 }}
  //       animate={{ opacity: 1, y: 0 }}
  //       transition={{ delay: 0.15 }}
  //       className="futuristic-card p-8"
  //     >
  //       <div className="flex items-center justify-center py-12">
  //         <Loader2 className="w-8 h-8 animate-spin text-primary" />
  //       </div>
  //     </motion.div>
  //   );
  // }

  // No subscription - show subscribe message - BYPASSED FOR TESTING
  if (!bypassSubscriptionCheck && !hasSubscription) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="futuristic-card p-8"
      >
        <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
          <Rocket className="w-5 h-5 text-primary" />
          Utiliser cet agent
        </h2>
        <div className="text-center py-8">
          <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-4">
            <Zap className="w-8 h-8 text-primary" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Abonnez-vous pour utiliser cet agent</h3>
          <p className="text-muted-foreground mb-6">
            Un abonnement est requis pour accéder aux agents IA.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              onClick={() => navigate('/pricing')}
              className="bg-gradient-to-r from-blue-500 to-cyan-500"
            >
              <Zap className="w-4 h-4 mr-2" />
              Starter - 33€/mois
            </Button>
            <Button
              onClick={() => navigate('/pricing')}
              className="bg-gradient-to-r from-purple-500 to-pink-500"
            >
              <Crown className="w-4 h-4 mr-2" />
              Premium - 99€/mois
            </Button>
          </div>
        </div>
      </motion.div>
    );
  }

  // Starter plan but agent not in selection - BYPASSED FOR TESTING
  if (!bypassSubscriptionCheck && isStarter && !isAgentInSelection) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="futuristic-card p-8"
      >
        <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
          <Rocket className="w-5 h-5" style={{ color: agent.color || 'hsl(var(--primary))' }} />
          Utiliser cet agent
        </h2>
        <div className="text-center py-8">
          <div className="w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-amber-500" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Agent non sélectionné</h3>
          <p className="text-muted-foreground mb-6">
            {remainingSlots > 0 
              ? `Ajoutez cet agent à votre sélection (${remainingSlots} place${remainingSlots > 1 ? 's' : ''} restante${remainingSlots > 1 ? 's' : ''}) ou passez au Premium.`
              : 'Vous avez atteint la limite de 5 agents. Passez au Premium pour tous les débloquer.'}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {canAddToSelection && (
              <Button
                onClick={handleAddToSelection}
                disabled={addingAgent}
                className="bg-gradient-to-r from-blue-500 to-cyan-500"
              >
                {addingAgent ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4 mr-2" />
                )}
                Ajouter à ma sélection
              </Button>
            )}
            <Button
              onClick={() => navigate('/pricing')}
              variant={canAddToSelection ? 'outline' : 'default'}
              className={canAddToSelection ? '' : 'bg-gradient-to-r from-purple-500 to-pink-500'}
            >
              <Crown className="w-4 h-4 mr-2" />
              Passer au Premium
            </Button>
            <Link to="/my-agents">
              <Button variant="ghost">
                Gérer mes agents
              </Button>
            </Link>
          </div>
        </div>
      </motion.div>
    );
  }

  // User can use the agent - show form
  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="futuristic-card p-8"
      >
        <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
          <Rocket className="w-5 h-5" style={{ color: agent.color || 'hsl(var(--primary))' }} />
          Utiliser cet agent
        </h2>

        <form onSubmit={handleSubmit} className="space-y-6">
          {renderFormFields()}

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button
            type="submit"
            disabled={isLoading}
            className="w-full bg-gradient-to-r from-primary to-accent hover:opacity-90"
            size="lg"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Traitement en cours...
              </>
            ) : (
              <>
                🚀 Lancer l'agent
              </>
            )}
          </Button>
        </form>
      </motion.div>

      {/* Result Modal */}
      <Dialog open={showResultModal} onOpenChange={setShowResultModal}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-500" />
              Résultat de l'agent
            </DialogTitle>
            <DialogDescription>
              L'agent "{agent.name}" a terminé son exécution.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 p-4 bg-muted rounded-lg">
            <pre className="whitespace-pre-wrap text-sm font-mono">
              {result}
            </pre>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setShowResultModal(false)}>
              Fermer
            </Button>
            <Button onClick={() => {
              setShowResultModal(false);
              setFormData({});
              setResult(null);
            }}>
              Nouvelle exécution
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
