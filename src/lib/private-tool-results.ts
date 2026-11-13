import { supabase } from '@/integrations/supabase/client';
import { createRequestDeadline } from '@/lib/request-deadline';

import {
  isPrivateToolResultId, parsePrivateToolResult, type PrivateToolResult,
} from '../../karta/src/knowledge/private-result-view';
export {
  isPrivateToolResultId, privateToolSourceUrl, parsePrivateToolResult,
  type PrivateToolName, type PrivateToolResultStatus, type PrivateToolSource, type PrivateToolResult,
} from '../../karta/src/knowledge/private-result-view';

interface ResultQuery extends PromiseLike<{ data: unknown; error: unknown }> {
  select(columns: string): ResultQuery;
  eq(column: string, value: string): ResultQuery;
  order(column: string, options: { ascending: boolean }): ResultQuery;
  limit(count: number): ResultQuery;
  setHeader(name: string, value: string): ResultQuery;
  abortSignal(signal: AbortSignal): ResultQuery;
  delete(): ResultQuery;
}

const resultClient = supabase as unknown as { from(table: 'karta_tool_results'): ResultQuery };
const READ_ERROR = 'Les résultats privés sont temporairement indisponibles. Réessaie dans quelques instants.';
const DELETE_ERROR = 'La suppression n’a pas pu être confirmée. Actualise les résultats ; si la mission est encore en cours, attends sa fin.';

async function ownedResultRequest<T>(
  ownerId: string,
  agentId: string,
  operation: (bearer: string, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!isPrivateToolResultId(ownerId) || !isPrivateToolResultId(agentId)) {
    throw new Error('Contexte de résultats invalide.');
  }
  const deadline = createRequestDeadline(20_000, signal);
  const transport = new AbortController();
  try {
    return await deadline.wait(async () => {
      const { data: { session }, error } = await supabase.auth.getSession();
      deadline.check();
      if (error || !session?.access_token || session.user.id !== ownerId) {
        throw new Error('Le compte actif a changé. Recharge les résultats depuis ce compte.');
      }
      // Pin this identity rather than letting a later SDK session choose a new bearer.
      const value = await operation(`Bearer ${session.access_token}`, transport.signal);
      deadline.check();
      return value;
    });
  } finally {
    transport.abort();
    deadline.close();
  }
}

export async function listPrivateToolResults(
  ownerId: string, agentId: string, signal?: AbortSignal,
): Promise<PrivateToolResult[]> {
  return ownedResultRequest(ownerId, agentId, async (bearer, requestSignal) => {
    const { data, error } = await resultClient.from('karta_tool_results')
      .select('id,run_id,creator_agent_id,user_id,tool_name,payload,created_at')
      .eq('user_id', ownerId).eq('creator_agent_id', agentId)
      .order('created_at', { ascending: false }).limit(20)
      .setHeader('Authorization', bearer).abortSignal(requestSignal);
    if (error || !Array.isArray(data) || data.length > 20) throw new Error(READ_ERROR);
    const ids = new Set<string>();
    return data.map((row: unknown) => {
      const result = parsePrivateToolResult(row, ownerId, agentId);
      if (!result || ids.has(result.id)) throw new Error(READ_ERROR);
      ids.add(result.id);
      return result;
    });
  }, signal);
}

export async function deletePrivateToolResult(
  ownerId: string, agentId: string, resultId: string, signal?: AbortSignal,
): Promise<void> {
  if (!isPrivateToolResultId(resultId)) throw new Error('Résultat privé invalide.');
  return ownedResultRequest(ownerId, agentId, async (bearer, requestSignal) => {
    const { data, error } = await resultClient.from('karta_tool_results').delete()
      .eq('id', resultId).eq('user_id', ownerId).eq('creator_agent_id', agentId)
      .select('id').setHeader('Authorization', bearer).abortSignal(requestSignal);
    if (error || !Array.isArray(data) || data.length !== 1 || data[0] === null
      || typeof data[0] !== 'object' || Array.isArray(data[0])
      || typeof data[0].id !== 'string' || data[0].id.toLowerCase() !== resultId.toLowerCase()) throw new Error(DELETE_ERROR);
  }, signal);
}
