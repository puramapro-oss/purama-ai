import { useState, useCallback, useLayoutEffect } from 'react';
import { useAuth } from './useAuth';
import type { AgentFieldConfig } from '@/config/agentConfigs';
import { createRequestScope } from '@/lib/request-scope';
import { useScopedState } from './useRequestScope';
import { supabase } from '@/integrations/supabase/client';
import { Json } from '@/integrations/supabase/types';

interface ExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  rawResponse?: string;
}

interface UseAgentExecutionReturn {
  execute: (formData: Record<string, unknown>) => Promise<ExecutionResult>;
  isLoading: boolean;
  result: ExecutionResult | null;
  error: string | null;
  reset: () => void;
}

export function useAgentExecution(agentSlug: string): UseAgentExecutionReturn {
  const { user } = useAuth();
  const ownerId = user?.id;
  const scopeKey = JSON.stringify([ownerId ?? null, agentSlug]);
  const [requests] = useState(createRequestScope);
  const [isLoading, setIsLoading] = useScopedState(scopeKey, false);
  const [result, setResult] = useScopedState<ExecutionResult | null>(scopeKey, null);
  const [error, setError] = useScopedState<string | null>(scopeKey, null);

  const reset = useCallback(() => {
    requests.invalidate();
    setResult(null);
    setError(null);
    setIsLoading(false);
  }, [requests, setResult, setError, setIsLoading]);

  useLayoutEffect(() => {
    reset();
    return () => requests.invalidate();
  }, [scopeKey, requests, reset]);

  const execute = useCallback(async (formData: Record<string, unknown>): Promise<ExecutionResult> => {
    if (!ownerId) {
      const err = 'Vous devez être connecté pour utiliser cet agent';
      setError(err);
      return { success: false, error: err };
    }

    const request = requests.begin('execution');
    if (!request) return { success: false, error: 'Une exécution est déjà en cours.' };
    const cancelled = (): ExecutionResult => ({
      success: false, error: 'Cette exécution ne concerne plus la session ou le formulaire courant.',
    });
    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      // Capture this owner's bearer before the SDK can select a successor session.
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (!request.current()) return cancelled();
      if (sessionError || !session?.access_token || session.user.id !== ownerId) {
        throw new Error('Le compte actif a changé. Relancez la demande depuis ce compte.');
      }

      // Check if we have file uploads - for now, files not supported via proxy
      const hasFile = Object.values(formData).some(v => v instanceof File);
      if (hasFile) {
        throw new Error("L'upload de fichiers n'est pas encore supporté");
      }

      // Call the agent-proxy edge function instead of n8n directly
      const { data: proxyResponse, error: proxyError } = await supabase.functions.invoke('agent-proxy', {
        body: {
          agentSlug,
          formData,
        },
        headers: { Authorization: 'Bearer ' + session.access_token },
        signal: request.signal,
      });
      if (!request.current()) return cancelled();

      if (proxyError) {
        throw new Error(proxyError.message || 'Erreur lors de l\'appel au proxy');
      }

      if (!proxyResponse.success) {
        throw new Error(proxyResponse.error || 'Erreur inconnue du workflow');
      }

      const parsedData = proxyResponse.data;

      // Log usage to database
      try {
        const { data: agentData } = await supabase
          .from('agents')
          .select('id')
          .eq('slug', agentSlug)
          .setHeader('Authorization', 'Bearer ' + session.access_token)
          .abortSignal(request.signal)
          .maybeSingle();
        if (!request.current()) return cancelled();

        if (agentData?.id) {
          const sanitizedFormData: Record<string, Json> = {};
          for (const [key, value] of Object.entries(formData)) {
            if (!(value instanceof File)) {
              sanitizedFormData[key] = value as Json;
            }
          }
          
          const metadata: Json = {
            formData: sanitizedFormData,
            responsePreview: typeof parsedData === 'string' 
              ? parsedData.substring(0, 200) 
              : JSON.stringify(parsedData).substring(0, 200),
          };

          await supabase.from('agent_usage').insert([{
            user_id: ownerId,
            agent_id: agentData.id,
            action_type: 'execution',
            status: 'completed',
            metadata,
          }]).setHeader('Authorization', 'Bearer ' + session.access_token).abortSignal(request.signal);
        }
      } catch (logError) {
        if (request.current()) console.warn('Failed to log agent usage:', logError);
      }
      if (!request.current()) return cancelled();

      const successResult: ExecutionResult = {
        success: true,
        data: parsedData,
        rawResponse: JSON.stringify(parsedData),
      };

      setResult(successResult);
      return successResult;

    } catch (err) {
      if (!request.current()) return cancelled();
      const errorMessage = err instanceof Error ? err.message : 'Une erreur est survenue';
      setError(errorMessage);
      
      const errorResult: ExecutionResult = {
        success: false,
        error: errorMessage,
      };
      
      setResult(errorResult);
      return errorResult;
    } finally {
      if (request.finish()) setIsLoading(false);
    }
  }, [agentSlug, ownerId, requests, setResult, setError, setIsLoading]);

  return {
    execute,
    isLoading,
    result,
    error,
    reset,
  };
}

/**
 * Validate form data against agent field configuration
 */
export function validateAgentFormData(
  formData: Record<string, unknown>,
  fields: AgentFieldConfig[]
): { isValid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  for (const field of fields) {
    const value = formData[field.name];

    // Check required fields
    if (field.required) {
      if (value === undefined || value === null || value === '') {
        errors[field.name] = `${field.label} est requis`;
        continue;
      }
      if (Array.isArray(value) && value.length === 0) {
        errors[field.name] = `Sélectionnez au moins une option pour ${field.label}`;
        continue;
      }
    }

    // Skip validation if value is empty and not required
    if (value === undefined || value === null || value === '') {
      continue;
    }

    // Type-specific validation
    switch (field.type) {
      case 'email': {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (typeof value === 'string' && !emailRegex.test(value)) {
          errors[field.name] = 'Adresse email invalide';
        }
        break;
      }

      case 'number': {
        const numValue = typeof value === 'string' ? parseFloat(value) : value;
        if (typeof numValue !== 'number' || isNaN(numValue)) {
          errors[field.name] = 'Valeur numérique invalide';
        } else if (field.validation) {
          if (field.validation.min !== undefined && numValue < field.validation.min) {
            errors[field.name] = `La valeur minimum est ${field.validation.min}`;
          }
          if (field.validation.max !== undefined && numValue > field.validation.max) {
            errors[field.name] = `La valeur maximum est ${field.validation.max}`;
          }
        }
        break;
      }

      case 'text':
      case 'textarea':
        if (field.validation?.pattern && typeof value === 'string') {
          if (!field.validation.pattern.test(value)) {
            errors[field.name] = field.validation.message || 'Format invalide';
          }
        }
        break;
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}
