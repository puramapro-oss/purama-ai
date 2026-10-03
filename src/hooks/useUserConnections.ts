import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

export type ServiceProvider = 'google_sheets' | 'gmail' | 'google_calendar' | 'google_drive';

export interface UserConnection {
  id: string;
  user_id: string;
  provider: ServiceProvider;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export const SERVICE_CONFIG: Record<ServiceProvider, {
  name: string;
  description: string;
  icon: string;
  scopes: string[];
  requiredByAgents: string[];
}> = {
  google_sheets: {
    name: 'Google Sheets',
    description: 'Accédez et modifiez vos feuilles de calcul',
    icon: '📊',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    requiredByAgents: ['crm-intelligent', 'data-analyst'],
  },
  gmail: {
    name: 'Gmail',
    description: 'Envoyez et lisez vos emails',
    icon: '📧',
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    requiredByAgents: ['email-marketing', 'support-client', 'prospection-auto'],
  },
  google_calendar: {
    name: 'Google Calendar',
    description: 'Gérez vos événements et rendez-vous',
    icon: '📅',
    scopes: ['https://www.googleapis.com/auth/calendar'],
    requiredByAgents: ['assistant-rh', 'planificateur'],
  },
  google_drive: {
    name: 'Google Drive',
    description: 'Accédez à vos fichiers et documents',
    icon: '📁',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
    requiredByAgents: ['document-analyzer', 'legal-assistant'],
  },
};

export function useUserConnections() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: connections = [], isLoading } = useQuery({
    queryKey: ['user-connections', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      
      const { data, error } = await supabase
        .from('user_connections')
        .select('*')
        .eq('user_id', user.id);
      
      if (error) throw error;
      return data as UserConnection[];
    },
    enabled: !!user?.id,
  });

  const isConnected = (provider: ServiceProvider): boolean => {
    const connection = connections.find(c => c.provider === provider);
    if (!connection?.token_expires_at) return !!connection;
    return new Date(connection.token_expires_at) > new Date();
  };

  const getConnection = (provider: ServiceProvider): UserConnection | undefined => {
    return connections.find(c => c.provider === provider);
  };

  const getRequiredServices = (agentSlug: string): ServiceProvider[] => {
    return Object.entries(SERVICE_CONFIG)
      .filter(([_, config]) => config.requiredByAgents.includes(agentSlug))
      .map(([provider]) => provider as ServiceProvider);
  };

  const getMissingConnections = (agentSlug: string): ServiceProvider[] => {
    const required = getRequiredServices(agentSlug);
    return required.filter(provider => !isConnected(provider));
  };

  const disconnect = useMutation({
    mutationFn: async (provider: ServiceProvider) => {
      if (!user?.id) throw new Error('Non authentifié');
      
      const { error } = await supabase
        .from('user_connections')
        .delete()
        .eq('user_id', user.id)
        .eq('provider', provider);
      
      if (error) throw error;
    },
    onSuccess: (_, provider) => {
      queryClient.invalidateQueries({ queryKey: ['user-connections', user?.id] });
      toast.success(`${SERVICE_CONFIG[provider].name} déconnecté`);
    },
    onError: () => {
      toast.error('Erreur lors de la déconnexion');
    },
  });

  const initiateOAuth = async (provider: ServiceProvider) => {
    if (!user?.id) {
      toast.error('Vous devez être connecté');
      return;
    }

    const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
    const codeVerifier = btoa(String.fromCharCode(...verifierBytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const session = (await supabase.auth.getSession()).data.session;
    if (!session?.access_token) {
      toast.error('Session expirée, veuillez vous reconnecter');
      return;
    }

    // Get OAuth URL from edge function
    const response = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/oauth-google?action=authorize`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider, codeChallenge, returnUrl: window.location.pathname }),
      }
    );

    if (!response.ok) {
      toast.error('Erreur lors de l\'initialisation OAuth');
      return;
    }

    const { authUrl, state } = await response.json();
    if (typeof authUrl !== 'string' || typeof state !== 'string') {
      toast.error('Réponse OAuth invalide');
      return;
    }
    sessionStorage.setItem('oauth_state', state);
    sessionStorage.setItem('oauth_code_verifier', codeVerifier);
    window.location.href = authUrl;
  };

  return {
    connections,
    isLoading,
    isConnected,
    getConnection,
    getRequiredServices,
    getMissingConnections,
    disconnect,
    initiateOAuth,
  };
}
