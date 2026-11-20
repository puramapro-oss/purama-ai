import type { ConsultationCatalog, ConsultationOperation, ConsultationPublicPlan } from '@/lib/consultation-client';

export const OPERATION = '91000000-0000-4000-8000-000000000001';
export const OTHER_OPERATION = '91000000-0000-4000-8000-000000000002';
export const OWNER = '92000000-0000-4000-8000-000000000001';
export const OTHER_OWNER = '92000000-0000-4000-8000-000000000002';

export function catalogFixture(): ConsultationCatalog {
  return {
    available: true, reason: 'ready', research: { search: true, scrape: true },
    models: ['primary-model', 'reviewer-model', 'third-model', 'fourth-model'].map(model => ({
      model, provider: 'provider', reflections: ['auto', 'maximum'], speeds: ['standard', 'ultra_fast'], maxOutputTokens: 8192,
      profiles: (['auto', 'maximum'] as const).flatMap(reflection => (['standard', 'ultra_fast'] as const).map(speed => ({
        reflection, speed, research: {
          maxSearches: speed === 'ultra_fast' ? 1 : 3, maxPages: speed === 'ultra_fast' ? 1 : 6,
          maxReviewers: speed === 'ultra_fast' ? 1 : 3, maxRounds: 1, concurrency: 2,
        },
      }))),
    })),
  };
}
export function operationFixture(operationId = OPERATION, status: ConsultationOperation['status'] = 'complete'): ConsultationOperation {
  const plan: ConsultationPublicPlan = {
    model: 'primary-model', reflection: 'maximum', speed: 'standard', maxOutputTokens: 8192, timeoutMs: 60000,
    research: { maxSearches: 3, maxPages: 6, maxReviewers: 3, maxRounds: 1, concurrency: 2 },
  };
  return {
    operationId, status, cancelRequested: status === 'cancelled',
    result: status === 'running' || status === 'cancelled' ? null : {
      status: 'complete', reason: 'completed', plan, answer: 'Une réponse utile.', citedSourceIds: ['source-1'],
      disagreements: ['Les estimations diffèrent.'], uncertainties: ['La date reste incertaine.'], verificationStatus: 'unverified',
      sources: [{ id: 'source-1', provider: 'perplexity', retrievedAt: '2026-11-13T10:00:00.000Z', url: 'https://example.com/source',
        title: 'Une source publique', text: 'Un extrait public.', contentKind: 'search_excerpt', verificationStatus: 'unverified', truncated: false }],
    },
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
