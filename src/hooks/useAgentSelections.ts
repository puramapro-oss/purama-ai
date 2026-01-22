import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

const MAX_SELECTIONS = 5;

interface AgentSelection {
  id: string;
  agent_id: string;
  created_at: string;
}

export function useAgentSelections() {
  const { user } = useAuth();
  const [selections, setSelections] = useState<AgentSelection[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchSelections = useCallback(async () => {
    if (!user) {
      setSelections([]);
      setIsLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('user_agent_selections')
        .select('*')
        .eq('user_id', user.id);

      if (error) throw error;
      setSelections(data || []);
    } catch (err) {
      console.error('Error fetching agent selections:', err);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchSelections();
  }, [fetchSelections]);

  const addAgent = async (agentId: string): Promise<boolean> => {
    if (!user) {
      toast.error('Connexion requise');
      return false;
    }

    if (selections.length >= MAX_SELECTIONS) {
      toast.error('Limite atteinte', {
        description: `Vous avez déjà sélectionné ${MAX_SELECTIONS} agents. Retirez-en un pour en ajouter un autre.`,
      });
      return false;
    }

    if (selections.some(s => s.agent_id === agentId)) {
      toast.info('Agent déjà sélectionné');
      return false;
    }

    try {
      const { error } = await supabase
        .from('user_agent_selections')
        .insert({ user_id: user.id, agent_id: agentId });

      if (error) throw error;

      await fetchSelections();
      toast.success('Agent ajouté à votre sélection');
      return true;
    } catch (err) {
      console.error('Error adding agent:', err);
      toast.error('Erreur lors de l\'ajout de l\'agent');
      return false;
    }
  };

  const removeAgent = async (agentId: string): Promise<boolean> => {
    if (!user) return false;

    try {
      const { error } = await supabase
        .from('user_agent_selections')
        .delete()
        .eq('user_id', user.id)
        .eq('agent_id', agentId);

      if (error) throw error;

      await fetchSelections();
      toast.success('Agent retiré de votre sélection');
      return true;
    } catch (err) {
      console.error('Error removing agent:', err);
      toast.error('Erreur lors de la suppression');
      return false;
    }
  };

  const hasAgent = (agentId: string): boolean => {
    return selections.some(s => s.agent_id === agentId);
  };

  return {
    selections,
    selectedAgentIds: selections.map(s => s.agent_id),
    isLoading,
    addAgent,
    removeAgent,
    hasAgent,
    remainingSlots: MAX_SELECTIONS - selections.length,
    maxSelections: MAX_SELECTIONS,
    refresh: fetchSelections,
  };
}
