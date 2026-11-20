import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: client }));

import { cloneTemplate, getPublicCreatorModel, listPublicAgents, listTemplates } from './creator-agent';

const modelId = '81000000-0000-4000-8000-000000000001';
const ownerId = '82000000-0000-4000-8000-000000000001';
const copyId = '83000000-0000-4000-8000-000000000001';
const model = { id: modelId, name: 'Préparer ma semaine', description: null, emoji: '🗓️', color: '#8B5CF6', category: 'productivity', is_public: true, is_template: false, is_active: true };

// The real PostgREST builder stays chainable through single/abortSignal.
function queryResult(result: { data: unknown; error: unknown }) {
  const promise = Promise.resolve(result);
  const query = {
    then: promise.then.bind(promise),
    abortSignal: vi.fn(() => query),
    single: vi.fn(() => query),
  };
  return query;
}

beforeEach(() => vi.resetAllMocks());

describe('adaptateur RPC de distribution', () => {
  it('n’appelle pas le serveur avec un identifiant invalide', async () => {
    expect(await getPublicCreatorModel('all')).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('charge la projection publique par identifiant et propage le signal d’annulation', async () => {
    const signal = new AbortController().signal;
    const abortSignal = vi.fn().mockResolvedValue({ data: [{ ...model, system_prompt: 'secret' }], error: null });
    client.rpc.mockReturnValue({ abortSignal });
    expect(await getPublicCreatorModel(modelId, signal)).toEqual(model);
    expect(client.rpc).toHaveBeenCalledWith('public_creator_models', { p_id: modelId });
    expect(abortSignal).toHaveBeenCalledTimes(1);
    expect(abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(abortSignal.mock.calls[0][0].aborted).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('distingue un retrait du modèle d’une erreur de chargement', async () => {
    client.rpc.mockReturnValueOnce(queryResult({ data: [], error: null }));
    expect(await getPublicCreatorModel(modelId)).toBeNull();
    const failure = { code: 'PGRST202', message: 'Migration absente' };
    client.rpc.mockReturnValueOnce(queryResult({ data: null, error: failure }));
    await expect(getPublicCreatorModel(modelId)).rejects.toEqual(failure);
  });

  it.each([
    { label: 'plusieurs lignes', data: [model, model] },
    { label: 'un autre identifiant', data: [{ ...model, id: copyId }] },
    { label: 'un modèle privé', data: [{ ...model, is_public: false }] },
    { label: 'un résultat nul', data: null },
  ])('refuse un résultat qui ne correspond pas au lien demandé : $label', async ({ data }) => {
    client.rpc.mockReturnValue(queryResult({ data, error: null }));
    await expect(getPublicCreatorModel(modelId)).rejects.toThrow('indisponible');
  });

  it('réutilise le catalogue public pour les deux écrans existants', async () => {
    client.rpc.mockReturnValue(queryResult({ data: [model], error: null }));
    expect(await listTemplates()).toEqual([model]);
    expect(await listPublicAgents()).toEqual([model]);
    expect(client.rpc.mock.calls).toEqual([
      ['public_creator_models', { p_kind: 'official' }],
      ['public_creator_models', { p_kind: 'community' }],
    ]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('ne laisse pas un titre blanc casser le catalogue entier', async () => {
    client.rpc.mockReturnValue(queryResult({ data: [{ ...model, name: '  ' }, model], error: null }));
    expect(await listPublicAgents()).toEqual([model]);
  });

  it('lie la demande au compte attendu et réutilise le même identifiant lors d’une nouvelle tentative', async () => {
    client.rpc.mockReturnValue(queryResult({ data: { id: copyId, user_id: ownerId, cloned_from: modelId }, error: null }));
    await cloneTemplate(ownerId, modelId, copyId);
    await cloneTemplate(ownerId, modelId, copyId);
    expect(client.rpc.mock.calls).toEqual(Array(2).fill([
      'clone_public_creator_model', { p_source_id: modelId, p_copy_id: copyId, p_expected_user_id: ownerId },
    ]));
    expect(client.from).not.toHaveBeenCalled();
  });

  it.each([
    { id: copyId, user_id: copyId, cloned_from: modelId },
    { id: modelId, user_id: ownerId, cloned_from: modelId },
    { id: copyId, user_id: ownerId, cloned_from: copyId },
    null,
  ])('ne confirme jamais la copie d’un autre utilisateur ou d’une autre demande (%j)', async data => {
    client.rpc.mockReturnValue(queryResult({ data, error: null }));
    await expect(cloneTemplate(ownerId, modelId, copyId)).rejects.toThrow('confirmée');
  });

  it('propage le retrait intervenu entre la présentation et la copie', async () => {
    const error = { code: 'P0002', message: 'Model unavailable' };
    client.rpc.mockReturnValue(queryResult({ data: null, error }));
    await expect(cloneTemplate(ownerId, modelId, copyId)).rejects.toEqual(error);
  });

  it('ne confirme pas une demande refusée après un changement de compte', async () => {
    const error = { code: '42501', message: 'Authentication changed or required' };
    client.rpc.mockReturnValue(queryResult({ data: null, error }));
    await expect(cloneTemplate(ownerId, modelId, copyId)).rejects.toEqual(error);
    expect(client.rpc).toHaveBeenCalledWith('clone_public_creator_model', {
      p_source_id: modelId, p_copy_id: copyId, p_expected_user_id: ownerId,
    });
  });
});
