import { describe, expect, it } from 'vitest';
import { sharedTrial, trialFromPrompt } from './iao-trial-entry';

describe('entrée locale des essais', () => {
  it('reprend la quantité et le budget explicites en centimes', () => {
    expect(trialFromPrompt('Mon panier : exactement 38 pièces, budget de 25,09 €.'))
      .toEqual({ kind: 'panier', initialUnits: 38, initialBudgetCents: 2509 });
  });
  it('laisse les données ambiguës à la saisie et reconnaît les autres familles', () => {
    expect(trialFromPrompt('exactement 4 pièces ou exactement 9 pièces, budget de 8 € ou budget de 9 €')).toEqual({kind: 'panier'});
    expect(trialFromPrompt('panier, budget de 5 € par lot')).toEqual({kind: 'panier'});
    expect(trialFromPrompt('panier avec un budget de 8 € à 15 €')).toEqual({kind: 'panier'});
    expect(trialFromPrompt('Comparer ma vidéo')).toEqual({kind: 'media'});
    expect(trialFromPrompt('Combien de participants à mon atelier ?')).toEqual({kind: 'atelier'});
    expect(trialFromPrompt('Un panier et une vidéo')).toEqual({kind: null});
    expect(trialFromPrompt('Bonjour')).toEqual({kind: null});
  });
  it('les liens de méthode sont limités aux identifiants acceptés sans données', () => {
    expect(sharedTrial('#essai/pendule')).toBe('pendule');
    expect(sharedTrial('#essai/correlation')).toBe('correlation');
    expect(trialFromPrompt('Calcule la corrélation')).toEqual({ kind: 'correlation' });
    expect(sharedTrial('#essai/pendule?seed=1')).toBeNull();
    expect(trialFromPrompt('un pendule de 50 cm')).toMatchObject({ kind: 'pendule', scienceInputs: { lengthMeters: 0.5 } });
    expect(trialFromPrompt('Simule un pendule double')).toMatchObject({ kind: null, scienceProblem: expect.any(String) });
    expect(sharedTrial('#essai/panier')).toBe('panier');
    for (const hash of ['#essai/panier?nom=Alice', '#essai/__proto__', '#essai/panier/4', '']) expect(sharedTrial(hash)).toBeNull();
  });
});
