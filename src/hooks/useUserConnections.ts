import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useRequestScope } from '@/hooks/useRequestScope';
import { createRequestScope } from '@/lib/request-scope';
import { invokeOAuth, storeOAuthContext, type GoogleOAuthProvider } from '@/lib/oauth-google';
import { toast } from 'sonner';

export type ServiceProvider = GoogleOAuthProvider;

export interface UserConnection {
  id: string;
  user_id: string;
  provider: ServiceProvider;
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
  const userId = user?.id ?? null;
  const captureAccount = useRequestScope(userId ?? 'anonymous');
  const [requests] = useState(createRequestScope);
  const queryClient = useQueryClient();
  useLayoutEffect(() => () => requests.invalidate(), [userId, requests]);

  const { data: connections = [], isLoading } = useQuery({
    queryKey: ['user-connections', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      
      const { data, error } = await supabase
        .from('user_connections')
        .select('id,user_id,provider,token_expires_at,created_at,updated_at')
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
    const isCurrent = captureAccount();
    if (!userId) {
      toast.error('Vous devez être connecté');
      return;
    }
    if (!isCurrent()) return;
    const request = requests.begin('oauth');
    if (!request) return;
    try {
      const result = await invokeOAuth('oauth-google', { action: 'authorize', provider }, userId, request.signal);
      if (!isCurrent() || !request.current()) return;
      if (typeof result.authUrl !== 'string' || typeof result.state !== 'string' ||
          !/^[0-9a-f]{64}$/.test(result.state) || typeof result.expiresAt !== 'string') throw new Error('Invalid OAuth response');
      const url = new URL(result.authUrl);
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' ||
          url.username || url.password || url.hash || url.searchParams.get('state') !== result.state) throw new Error('Invalid OAuth destination');
      storeOAuthContext({ state: result.state, userId, provider, purpose: 'google_connections', expiresAt: result.expiresAt });
      if (!isCurrent() || !request.current()) return;
      window.location.assign(url.href);
    } catch {
      if (isCurrent() && request.current()) toast.error('Impossible de démarrer la connexion. Réessayez.');
    } finally {
      request.finish();
    }
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
