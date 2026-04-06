import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { 
  Rocket, 
  Loader2, 
  AlertCircle,
  CheckCircle2,
  Send,
  Upload,
  Calendar,
  Clock,
  ChevronDown,
  FlaskConical
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { getAgentConfig, AgentFieldConfig } from '@/config/agentConfigs';
import { useAgentExecution, validateAgentFormData } from '@/hooks/useAgentExecution';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import { PublishEverywhereButton } from '@/components/social/PublishEverywhereButton';
import { maybeAutopilot } from '@/lib/social';

interface DynamicAgentFormProps {
  agentSlug: string;
  agentName: string;
  agentColor?: string | null;
}

export function DynamicAgentForm({ agentSlug, agentName, agentColor }: DynamicAgentFormProps) {
  const agentConfig = getAgentConfig(agentSlug);
  const { execute, isLoading, result, reset } = useAgentExecution(agentSlug);
  
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showResultModal, setShowResultModal] = useState(false);
  const [selectedMulti, setSelectedMulti] = useState<Record<string, string[]>>({});

  // Reset form when agent changes
  useEffect(() => {
    setFormData({});
    setErrors({});
    setSelectedMulti({});
    reset();
  }, [agentSlug, reset]);

  const handleInputChange = (fieldName: string, value: unknown) => {
    setFormData(prev => ({ ...prev, [fieldName]: value }));
    // Clear error when user types
    if (errors[fieldName]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[fieldName];
        return newErrors;
      });
    }
  };

  const handleMultiSelectToggle = (fieldName: string, optionValue: string) => {
    setSelectedMulti(prev => {
      const current = prev[fieldName] || [];
      const updated = current.includes(optionValue)
        ? current.filter(v => v !== optionValue)
        : [...current, optionValue];
      
      // Also update formData
      setFormData(fd => ({ ...fd, [fieldName]: updated }));
      
      return { ...prev, [fieldName]: updated };
    });
  };

  const handleFileChange = (fieldName: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleInputChange(fieldName, file);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!agentConfig) {
      toast.error('Configuration de l\'agent introuvable');
      return;
    }

    // Validate form
    const validation = validateAgentFormData(formData, agentConfig.fields);
    if (!validation.isValid) {
      setErrors(validation.errors);
      toast.error('Formulaire incomplet', {
        description: 'Veuillez corriger les erreurs avant de continuer',
      });
      return;
    }

    // Execute agent
    const result = await execute(formData);
    
    if (result.success) {
      setShowResultModal(true);
      toast.success('Agent exécuté avec succès !');

      // Social Autopilot: if user has it enabled, push the generated content
      // to all connected social accounts. Silent on failure.
      const text = typeof result.data === 'string'
        ? result.data
        : (() => {
            try { return JSON.stringify(result.data); } catch { return ''; }
          })();
      if (text) {
        maybeAutopilot({
          content: text,
          contentType: 'text',
          agentName,
        });
      }
    } else {
      toast.error('Erreur d\'exécution', {
        description: result.error || 'Une erreur est survenue',
      });
    }
  };

  const handleNewExecution = () => {
    setShowResultModal(false);
    setFormData({});
    setSelectedMulti({});
    setErrors({});
    reset();
  };

  const renderField = (field: AgentFieldConfig) => {
    const value = formData[field.name];
    const error = errors[field.name];
    const baseInputClass = error ? 'border-destructive' : '';

    switch (field.type) {
      case 'text':
      case 'email':
      case 'number':
        return (
          <div key={field.name} className="space-y-2">
            <Label htmlFor={field.name} className="text-foreground">
              {field.label}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Input
              id={field.name}
              type={field.type}
              placeholder={field.placeholder}
              value={typeof value === 'string' || typeof value === 'number' ? value : ''}
              onChange={(e) => handleInputChange(field.name, 
                field.type === 'number' ? e.target.value : e.target.value
              )}
              className={baseInputClass}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        );

      case 'textarea':
        return (
          <div key={field.name} className="space-y-2">
            <Label htmlFor={field.name} className="text-foreground">
              {field.label}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Textarea
              id={field.name}
              placeholder={field.placeholder}
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => handleInputChange(field.name, e.target.value)}
              rows={4}
              className={baseInputClass}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        );

      case 'select':
        return (
          <div key={field.name} className="space-y-2">
            <Label htmlFor={field.name} className="text-foreground">
              {field.label}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Select
              value={typeof value === 'string' ? value : ''}
              onValueChange={(val) => handleInputChange(field.name, val)}
            >
              <SelectTrigger id={field.name} className={baseInputClass}>
                <SelectValue placeholder={`Sélectionner ${field.label.toLowerCase()}`} />
              </SelectTrigger>
              <SelectContent>
                {field.options?.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        );

      case 'multiselect':
        const selected = selectedMulti[field.name] || [];
        return (
          <div key={field.name} className="space-y-2">
            <Label className="text-foreground">
              {field.label}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <div className="flex flex-wrap gap-2 p-3 border rounded-md bg-background min-h-[44px]">
              {field.options?.map((option) => {
                const isSelected = selected.includes(option.value);
                return (
                  <Badge
                    key={option.value}
                    variant={isSelected ? 'default' : 'outline'}
                    className={`cursor-pointer transition-all ${
                      isSelected 
                        ? 'bg-primary hover:bg-primary/90' 
                        : 'hover:bg-secondary'
                    }`}
                    onClick={() => handleMultiSelectToggle(field.name, option.value)}
                  >
                    {option.label}
                    {isSelected && <span className="ml-1">✓</span>}
                  </Badge>
                );
              })}
            </div>
            {selected.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {selected.length} sélectionné(s)
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        );

      case 'date':
        return (
          <div key={field.name} className="space-y-2">
            <Label htmlFor={field.name} className="text-foreground flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              {field.label}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Input
              id={field.name}
              type="date"
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => handleInputChange(field.name, e.target.value)}
              className={baseInputClass}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        );

      case 'time':
        return (
          <div key={field.name} className="space-y-2">
            <Label htmlFor={field.name} className="text-foreground flex items-center gap-2">
              <Clock className="w-4 h-4" />
              {field.label}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Input
              id={field.name}
              type="time"
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => handleInputChange(field.name, e.target.value)}
              className={baseInputClass}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        );

      case 'file':
        return (
          <div key={field.name} className="space-y-2">
            <Label htmlFor={field.name} className="text-foreground flex items-center gap-2">
              <Upload className="w-4 h-4" />
              {field.label}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Input
              id={field.name}
              type="file"
              onChange={(e) => handleFileChange(field.name, e)}
              className={`cursor-pointer file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 ${baseInputClass}`}
            />
            {value instanceof File && (
              <p className="text-sm text-muted-foreground">
                Fichier sélectionné: {value.name}
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        );

      case 'boolean':
        return (
          <div key={field.name} className="flex items-center space-x-3 py-2">
            <Checkbox
              id={field.name}
              checked={value === true}
              onCheckedChange={(checked) => handleInputChange(field.name, checked)}
            />
            <Label htmlFor={field.name} className="text-foreground cursor-pointer">
              {field.label}
            </Label>
          </div>
        );

      default:
        return null;
    }
  };

  // Format result for display
  const formatResult = (data: unknown): string => {
    if (typeof data === 'string') {
      return data;
    }
    if (typeof data === 'object') {
      return JSON.stringify(data, null, 2);
    }
    return String(data);
  };

  // If no config found, show generic form
  if (!agentConfig) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="futuristic-card p-8"
      >
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Configuration de l'agent non trouvée. Veuillez contacter le support.
          </AlertDescription>
        </Alert>
      </motion.div>
    );
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="futuristic-card p-8"
      >
        <h2 className="text-xl font-semibold mb-2 flex items-center gap-2">
          <Rocket 
            className="w-5 h-5" 
            style={{ color: agentColor || 'hsl(var(--primary))' }} 
          />
          Utiliser cet agent
        </h2>
        
        {agentConfig.description && (
          <p className="text-muted-foreground mb-6">{agentConfig.description}</p>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {agentConfig.fields.map(renderField)}

          {Object.keys(errors).length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Veuillez corriger les erreurs ci-dessus
              </AlertDescription>
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
                <Send className="w-4 h-4 mr-2" />
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
              {/* Demo mode badge */}
              {result?.success && result.data && typeof result.data === 'object' && 
               (result.data as Record<string, unknown>).demo_mode && (
                <Badge variant="outline" className="ml-2 bg-amber-500/10 text-amber-500 border-amber-500/30">
                  <FlaskConical className="w-3 h-3 mr-1" />
                  Mode démo
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              L'agent "{agentName}" a terminé son exécution.
              {result?.success && result.data && typeof result.data === 'object' && 
               (result.data as Record<string, unknown>).demo_mode && (
                <span className="block mt-1 text-amber-500 text-xs">
                  Cette réponse est simulée. Les workflows n8n ne sont pas encore configurés.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          
          <div className="mt-4 p-4 bg-muted rounded-lg overflow-auto">
            {result?.success && result.data ? (
              typeof result.data === 'string' ? (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown>{result.data}</ReactMarkdown>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap text-sm font-mono">
                  {formatResult(result.data)}
                </pre>
              )
            ) : (
              <p className="text-muted-foreground">Aucun résultat retourné</p>
            )}
          </div>
          
          <div className="flex flex-wrap justify-end gap-2 mt-4">
            {result?.success && result.data && (
              <PublishEverywhereButton
                content={
                  typeof result.data === 'string'
                    ? result.data
                    : formatResult(result.data)
                }
                contentType="text"
                agentName={agentName}
              />
            )}
            <Button variant="outline" onClick={() => setShowResultModal(false)}>
              Fermer
            </Button>
            <Button onClick={handleNewExecution}>
              Nouvelle exécution
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
