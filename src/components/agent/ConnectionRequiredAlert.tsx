import { Link } from 'react-router-dom';
import { AlertCircle, Link2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useUserConnections, SERVICE_CONFIG, ServiceProvider } from '@/hooks/useUserConnections';

interface ConnectionRequiredAlertProps {
  agentSlug: string;
}

export function ConnectionRequiredAlert({ agentSlug }: ConnectionRequiredAlertProps) {
  const { getMissingConnections } = useUserConnections();
  
  const missingConnections = getMissingConnections(agentSlug);
  
  if (missingConnections.length === 0) {
    return null;
  }

  return (
    <Alert className="border-orange-500/30 bg-orange-500/10">
      <AlertCircle className="h-5 w-5 text-orange-500" />
      <AlertTitle className="text-orange-400">Connexion requise</AlertTitle>
      <AlertDescription className="mt-2">
        <p className="text-muted-foreground mb-3">
          Cet agent nécessite l'accès à vos comptes pour fonctionner :
        </p>
        <div className="flex flex-wrap gap-2 mb-4">
          {missingConnections.map((provider: ServiceProvider) => (
            <div 
              key={provider}
              className="flex items-center gap-2 px-3 py-1.5 bg-secondary rounded-lg"
            >
              <span>{SERVICE_CONFIG[provider].icon}</span>
              <span className="text-sm font-medium">{SERVICE_CONFIG[provider].name}</span>
            </div>
          ))}
        </div>
        <Button asChild>
          <Link to="/mes-connexions">
            <Link2 className="w-4 h-4 mr-2" />
            Connecter mes comptes
          </Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}
