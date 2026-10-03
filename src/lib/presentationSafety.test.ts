import { describe, expect, it } from 'vitest';
import { runProvenanceLabel, unavailableLiveDataLabel } from './presentationSafety';

describe('presentation safety boundaries', () => {
  it('identifie explicitement un résultat de test sans exposer de marqueur interne', () => {
    const label = runProvenanceLabel(true);

    expect(label).toBe('Mode test — résultat simulé');
    expect(label).not.toMatch(/\[MOCK\]|TODO_LIVE_TEST/);
  });

  it('ne marque pas une vraie décision comme simulée', () => {
    expect(runProvenanceLabel(false)).toBeNull();
  });

  it('affiche un état indisponible au lieu de fabriquer une métrique', () => {
    expect(unavailableLiveDataLabel('Stripe')).toBe('Données indisponibles — connexion Stripe requise');
  });
});
