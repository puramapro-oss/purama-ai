import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateToolResults } from './PrivateToolResults';
import type { PrivateToolResult } from '@/lib/private-tool-results';

const api = vi.hoisted(() => ({ listPrivateToolResults: vi.fn(), deletePrivateToolResult: vi.fn() }));
vi.mock('@/lib/private-tool-results', () => api);

const OWNER = '81000000-0000-4000-8000-000000000001';
const AGENT = '82000000-0000-4000-8000-000000000001';
const SESSION = '82000000-0000-4000-8000-000000000002';
const OTHER = '82000000-0000-4000-8000-000000000003';
const at = '2026-11-12T10:00:00.000Z';

function result(index: number, summary = `Résultat privé ${index}`): PrivateToolResult {
  return {
    id: `83000000-0000-4000-8000-00000000000${index}`,
    run_id: `84000000-0000-4000-8000-00000000000${index}`,
    creator_agent_id: AGENT, user_id: OWNER, tool_name: 'knowledge_search', created_at: at,
    payload: {
      schema_version: 1, tool_name: 'knowledge_search', status: 'complete', summary,
      sources: [{ source: 'wikidata', native_id: 'Q42', label: 'Référence <img src=x>', url: 'https://www.wikidata.org/wiki/Q42', retrieved_at: at }],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

let root: Root | null;
let host: HTMLDivElement;
let props: ComponentProps<typeof PrivateToolResults>;
async function render(change: Partial<typeof props> = {}) {
  props = { ...props, ...change };
  await act(async () => { root?.render(<PrivateToolResults {...props} />); });
}
function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(element => element.textContent?.trim() === text);
  if (!found) throw new Error(`Bouton absent : ${text}`);
  return found;
}
async function click(text: string) { await act(async () => { button(text).click(); }); }

beforeEach(() => {
  vi.clearAllMocks();
  api.listPrivateToolResults.mockReset().mockResolvedValue([result(1)]);
  api.deletePrivateToolResult.mockReset().mockResolvedValue(undefined);
  props = {
    ownerId: OWNER, agentId: AGENT, sessionId: SESSION, selectedIds: [],
    onToggle: vi.fn(), onRemove: vi.fn(), onUseResults: vi.fn(),
  };
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('panneau de résultats privés', () => {
  it('affiche la synthèse entière comme texte de modèle sans inventer de références', async () => {
    const summary = '<img src=x onerror=alert(1)>\n' + 'Texte complet 🌍\n'.repeat(500) + 'FIN_DU_RAPPORT';
    const row = result(1, summary);
    row.tool_name = 'programmatic_report';
    row.payload.tool_name = 'programmatic_report';
    row.payload.sources = [];
    api.listPrivateToolResults.mockResolvedValue([row]);
    await render();
    expect(host.querySelector('h3')?.textContent).toBe('Synthèse de recherche');
    expect(host.querySelector('p.whitespace-pre-wrap')?.textContent).toBe(summary);
    expect(host.textContent).toContain('Synthèse générée par le modèle');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
    expect(host.querySelector('input')?.getAttribute('aria-label')).toContain('synthèse de recherche');
    expect(props.onUseResults).not.toHaveBeenCalled();
    expect(api.deletePrivateToolResult).not.toHaveBeenCalled();
  });

  it('rend le contenu fournisseur en texte et nomme les contrôles sans synthèse automatique', async () => {
    api.listPrivateToolResults.mockResolvedValue([result(1, '<img src=x onerror=alert(1)> **texte**')]);
    await render();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)> **texte**');
    expect(host.textContent).toContain('Référence <img src=x>');
    expect(host.querySelector('img')).toBeNull();
    const link = host.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://www.wikidata.org/wiki/Q42');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.getAttribute('target')).toBe('_blank');
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.getAttribute('aria-label')).toContain('à ma prochaine question');
    await act(async () => { checkbox?.click(); });
    expect(props.onToggle).toHaveBeenCalledWith(result(1).id);
    expect(props.onUseResults).not.toHaveBeenCalled();
    expect(api.deletePrivateToolResult).not.toHaveBeenCalled();
  });

  it('limite la sélection à trois tout en permettant de retirer un résultat sélectionné', async () => {
    const rows = [result(1), result(2), result(3), result(4)];
    api.listPrivateToolResults.mockResolvedValue(rows);
    await render({ selectedIds: rows.slice(0, 3).map(row => row.id) });
    const inputs = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(inputs.map(input => input.disabled)).toEqual([false, false, false, true]);
    expect(inputs.map(input => input.checked)).toEqual([true, true, true, false]);
    await act(async () => { inputs[3].click(); inputs[0].click(); });
    expect(props.onToggle).toHaveBeenCalledExactlyOnceWith(rows[0].id);
    await click('Poser une question avec ces résultats');
    expect(props.onUseResults).toHaveBeenCalledOnce();
  });

  it('demande une confirmation, attend le DELETE confirmé puis retire la carte et restaure le focus', async () => {
    const pending = deferred<void>();
    api.deletePrivateToolResult.mockReturnValueOnce(pending.promise);
    await render({ selectedIds: [result(1).id] });
    await click('Supprimer');
    expect(api.deletePrivateToolResult).not.toHaveBeenCalled();
    await click('Confirmer la suppression');
    expect(api.deletePrivateToolResult).toHaveBeenCalledExactlyOnceWith(OWNER, AGENT, result(1).id, expect.any(AbortSignal));
    expect(host.querySelectorAll('article')).toHaveLength(1);
    expect(props.onRemove).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(); });
    expect(host.querySelectorAll('article')).toHaveLength(0);
    expect(props.onRemove).toHaveBeenCalledExactlyOnceWith(result(1).id);
    expect(document.activeElement).toBe(host.querySelector('h2'));
  });

  it('conserve la carte et la sélection si la suppression est refusée, puis permet de réessayer', async () => {
    api.deletePrivateToolResult.mockRejectedValueOnce(new Error('Operation is still running; internal details'));
    await render({ selectedIds: [result(1).id] });
    await click('Supprimer');
    await click('Confirmer la suppression');
    expect(host.querySelectorAll('article')).toHaveLength(1);
    expect(host.querySelector<HTMLInputElement>('input')?.checked).toBe(true);
    expect(host.textContent).toContain('mission est encore en cours');
    expect(host.textContent).not.toContain('internal details');
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(button('Confirmer la suppression').disabled).toBe(false);
    await click('Annuler');
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(document.activeElement).toBe(button('Supprimer'));
  });

  it.each(['ownerId', 'agentId', 'sessionId'] as const)(
    'ignore une lecture tardive lors d’un aller-retour de %s', async field => {
      const pending = deferred<PrivateToolResult[]>();
      api.listPrivateToolResults.mockReturnValueOnce(pending.promise);
      await render();
      const original = props[field];
      const expiredSignal = api.listPrivateToolResults.mock.calls[0][2] as AbortSignal;
      await render({ [field]: OTHER });
      await render({ [field]: original });
      expect(expiredSignal.aborted).toBe(true);
      await act(async () => { pending.resolve([result(2, 'ANCIEN COMPTE OU SESSION')]); });
      expect(host.textContent).not.toContain('ANCIEN COMPTE OU SESSION');
      expect(host.textContent).toContain('Résultat privé 1');
    },
  );

  it('ignore la suppression et son focus tardifs après changement de session, même au retour', async () => {
    const pending = deferred<void>();
    api.deletePrivateToolResult.mockReturnValueOnce(pending.promise);
    await render();
    await click('Supprimer');
    await click('Confirmer la suppression');
    const signal = api.deletePrivateToolResult.mock.calls[0][3] as AbortSignal;
    await render({ sessionId: OTHER });
    await render({ sessionId: SESSION });
    const focus = button('Actualiser les résultats');
    focus.focus();
    await act(async () => { pending.resolve(); });
    expect(signal.aborted).toBe(true);
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(host.querySelectorAll('article')).toHaveLength(1);
    expect(document.activeElement).toBe(focus);
  });

  it('ignore une erreur de lecture périmée et annule au démontage', async () => {
    const first = deferred<PrivateToolResult[]>();
    const second = deferred<PrivateToolResult[]>();
    api.listPrivateToolResults.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render();
    await render({ ownerId: OTHER });
    await act(async () => { first.reject(new Error('Old account error')); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const signal = api.listPrivateToolResults.mock.calls[1][2] as AbortSignal;
    await act(async () => { root?.unmount(); });
    root = null;
    expect(signal.aborted).toBe(true);
    await act(async () => { second.resolve([result(1)]); });
    expect(props.onRemove).not.toHaveBeenCalled();
  });
});

function resolutionResult(): PrivateToolResult {
  const row = result(1, 'Analyse de six rubriques à partir des informations fournies.');
  row.tool_name = 'qualify_resolution';
  row.payload.tool_name = 'qualify_resolution';
  row.payload.sources = [];
  row.payload.resolution = {
    snapshot: { caseId: 'dossier-fourni-ancien', snapshotRevision: 3, asOf: '2022-01-10T12:00:00Z' },
    sections: [
      { id: 'dependencies', title: 'Prérequis', availability: 'provided', summary: 'Une condition reste à préciser.', items: ['Élément <img src=x> à rapprocher.'] },
      { id: 'transitions', title: 'Transitions', availability: 'provided', summary: 'Une période reste sans couverture déclarée.', items: ['Couverture réelle non vérifiée.'] },
      { id: 'effort', title: 'Effort choisi', availability: 'provided', summary: 'Deux minutes choisies.', items: ['Aucun droit supplémentaire.'] },
      { id: 'corrections', title: 'Conséquences d’une correction', availability: 'provided', summary: 'Un impact demeure inconnu.', items: ['Lien intermédiaire absent.'] },
      { id: 'occurrence', title: 'Récurrence et reprises', availability: 'not_provided', summary: 'Informations non fournies pour cette rubrique.', items: [] },
      { id: 'handoffs', title: 'Passation', availability: 'provided', summary: 'Demande préparée ; réalisation non vérifiée.', items: ['Le rôle de parent n’accorde aucun mandat.'] },
    ],
    supplied_references: [{ id: 'reference-declaree', caseId: 'autre-dossier', snapshotRevision: 2,
      subjectId: 'element-fourni', kind: 'authorization',
      reference: 'javascript:alert(1) <img src=x onerror=alert(1)> REFERENCE_PRIVEE', observedAt: '2026-02-30T12:00:00Z' }],
    rejected_source_ids: ['reference-declaree'],
  };
  return row;
}

describe('analyse privée de dossier', () => {
  it('présente les six rubriques et l’instantané fourni sans afficher un objectif atteint', async () => {
    api.listPrivateToolResults.mockResolvedValue([resolutionResult()]);
    await render();
    expect(host.querySelector('h3')?.textContent).toBe('Analyse de dossier');
    expect(host.textContent).toContain('Analyse disponible');
    expect(host.textContent).not.toContain('Complet');
    expect([...host.querySelectorAll('h4')].map(heading => heading.textContent)).toEqual([
      'Prérequis', 'Transitions', 'Effort choisi', 'Conséquences d’une correction', 'Récurrence et reprises', 'Passation',
    ]);
    expect(host.textContent).toContain('dossier-fourni-ancien');
    expect(host.textContent).toContain('Révision fournie3');
    expect(host.textContent).toContain('Date de l’instantané fournie');
    expect(host.querySelector('time[datetime="2022-01-10T12:00:00Z"]')).not.toBeNull();
    expect(host.textContent).toContain('Enregistrée le');
    expect(host.querySelector(`time[datetime="${at}"]`)).not.toBeNull();
    expect(host.textContent).toContain('Informations non fournies');
    expect(host.textContent).toContain('Les références et les droits restent à vérifier');
    expect(host.textContent).toContain('aucune démarche extérieure');
    expect(props.onUseResults).not.toHaveBeenCalled();
    expect(api.deletePrivateToolResult).not.toHaveBeenCalled();
  });

  it('conserve les détails et références comme texte déclaré sans lien ni interprétation de date invalide', async () => {
    api.listPrivateToolResults.mockResolvedValue([resolutionResult()]);
    await render();
    expect(host.querySelectorAll('details')).toHaveLength(7);
    expect(host.querySelector('details')?.open).toBe(false);
    expect(host.querySelector('details summary')?.textContent).toBe('Contexte et orientations du dossier');
    expect(host.querySelector('details p')?.textContent).toBe(resolutionResult().payload.summary);
    expect(host.textContent).toContain('Élément <img src=x> à rapprocher.');
    expect(host.textContent).toContain('Références fournies (1)');
    expect(host.textContent).toContain('Non retenue par l’analyse');
    expect(host.textContent).toContain('Autorisation déclarée');
    expect(host.textContent).toContain('autre-dossier');
    expect(host.textContent).toContain('element-fourni');
    expect(host.textContent).toContain('2026-02-30T12:00:00Z');
    expect(host.textContent).toContain('javascript:alert(1) <img src=x onerror=alert(1)> REFERENCE_PRIVEE');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.getAttribute('aria-label')).toContain('analyse de dossier');
    await act(async () => { checkbox?.click(); });
    expect(props.onToggle).toHaveBeenCalledExactlyOnceWith(resolutionResult().id);
    expect(props.onUseResults).not.toHaveBeenCalled();
  });

  it('retire les références privées immédiatement lors du changement de compte', async () => {
    const pending = deferred<PrivateToolResult[]>();
    api.listPrivateToolResults.mockResolvedValueOnce([resolutionResult()]).mockReturnValueOnce(pending.promise);
    await render();
    expect(host.textContent).toContain('REFERENCE_PRIVEE');
    await render({ ownerId: OTHER });
    expect(host.textContent).not.toContain('REFERENCE_PRIVEE');
    expect(host.textContent).not.toContain('dossier-fourni-ancien');
    await act(async () => { pending.resolve([]); });
    expect(host.textContent).toContain('Aucun résultat privé disponible');
  });
});
