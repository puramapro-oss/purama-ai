import { useState, useCallback } from 'react';
import { useAuth } from './useAuth';
import { getAgentWebhookUrl, getAgentConfig, AgentFieldConfig } from '@/config/agentConfigs';
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
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
    setIsLoading(false);
  }, []);

  const execute = useCallback(async (formData: Record<string, unknown>): Promise<ExecutionResult> => {
    if (!user) {
      const err = 'Vous devez être connecté pour utiliser cet agent';
      setError(err);
      return { success: false, error: err };
    }

    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const webhookUrl = getAgentWebhookUrl(agentSlug);
      const agentConfig = getAgentConfig(agentSlug);

      // Prepare the payload
      const payload: Record<string, unknown> = {
        // Agent metadata
        agentSlug,
        agentName: agentConfig?.name || agentSlug,
        // User metadata
        user_id: user.id,
        userEmail: user.email,
        // Timestamp
        timestamp: new Date().toISOString(),
        // Form data
        ...formData,
      };

      // Check if we need to send as FormData (for file uploads)
      const hasFileField = agentConfig?.fields.some(f => f.type === 'file');
      const hasFile = Object.values(formData).some(v => v instanceof File);

      let response: Response;

      if (hasFileField && hasFile) {
        // Send as FormData for file uploads
        const formDataPayload = new FormData();
        Object.entries(payload).forEach(([key, value]) => {
          if (value instanceof File) {
            formDataPayload.append(key, value);
          } else if (value !== undefined && value !== null) {
            formDataPayload.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
          }
        });

        response = await fetch(webhookUrl, {
          method: 'POST',
          body: formDataPayload,
        });
      } else {
        // Send as JSON
        response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
      }

      // Parse response
      const responseText = await response.text();
      let parsedData: unknown;

      try {
        parsedData = JSON.parse(responseText);
      } catch {
        // Response is not JSON, use raw text
        parsedData = responseText;
      }

      if (!response.ok) {
        throw new Error(`Erreur ${response.status}: ${responseText || 'Échec de la requête'}`);
      }

      // Log usage to database - we need to get the actual agent UUID first
      try {
        // First, get the agent ID from the slug
        const { data: agentData } = await supabase
          .from('agents')
          .select('id')
          .eq('slug', agentSlug)
          .maybeSingle();

        if (agentData?.id) {
          // Prepare metadata as Json-compatible object
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
            user_id: user.id,
            agent_id: agentData.id,
            action_type: 'execution',
            status: 'completed',
            metadata,
          }]);
        }
      } catch (logError) {
        console.warn('Failed to log agent usage:', logError);
        // Don't fail the main operation if logging fails
      }

      const successResult: ExecutionResult = {
        success: true,
        data: parsedData,
        rawResponse: responseText,
      };

      setResult(successResult);
      return successResult;

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Une erreur est survenue';
      setError(errorMessage);
      
      const errorResult: ExecutionResult = {
        success: false,
        error: errorMessage,
      };
      
      setResult(errorResult);
      return errorResult;
    } finally {
      setIsLoading(false);
    }
  }, [agentSlug, user]);

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
      case 'email':
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (typeof value === 'string' && !emailRegex.test(value)) {
          errors[field.name] = 'Adresse email invalide';
        }
        break;

      case 'number':
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
