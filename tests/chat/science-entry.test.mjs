import test from 'node:test';
import assert from 'node:assert/strict';
import { scienceFromPrompt, pendulumUrl, readPendulumReceipt, scienceHandoffUrl } from '../../src/lib/iao-science-entry.ts';

test('unités, virgules décimales, bornes et nombres de tirages', () => {
  for (const [prompt, inputs] of [
    ['Simule un pendule de 80 cm à 12 degrés', { lengthMeters: 0.8, angleDegrees: 12 }],
    ['Peux-tu simuler un pendule de longueur 800 mm avec une masse de 0,025 kg et un angle initial de 2,5° ?', { lengthMeters: 0.8, bobMassGrams: 25, angleDegrees: 2.5 }],
    ['Simule un pendule de 10 cm, 1°, 1000 mg, graine 0, 1 tirage.', { lengthMeters: 0.1, angleDegrees: 1, bobMassGrams: 1, seed: 0, samples: 1 }],
    ['Simule un pendule de 1,5 m, 30°, 100 g, graine 4294967295, 20000 échantillons.', { lengthMeters: 1.5, angleDegrees: 30, bobMassGrams: 100, seed: 4294967295, samples: 20000 }],
    ['Simule un pendule simple', {}],
  ]) {
    const result = scienceFromPrompt(prompt);
    assert.equal(result?.kind, 'pendule', prompt);
    assert.deepEqual(result.inputs, inputs);
    assert.match(result.answer, /modèle et vos mesures/);
  }
});

test('écarte grandeurs ambiguës, hors intervalle, et physique non couverte', () => {
  for (const prompt of ['10 ou 20 cm', 'un pendule double', 'un pendule de Foucault', 'sur la Lune', '2 m', '0 cm', '101 g', '31°', '20 cm ou 80 cm',
    '20 cm et 40 cm', 'avec une masse de 12 degrés', 'graine 4294967296', '3,5 tirages', '20001 tirages', '½ m', 'longueur', '1 rad', '0,4 m/s']) {
    assert.equal(scienceFromPrompt('Simule un pendule ' + prompt)?.kind, 'unsupported', prompt);
  }
  for (const prompt of ['Une expérience scientifique', 'Simule une réaction chimique', 'Simule une éclipse']) {
    assert.equal(scienceFromPrompt(prompt)?.kind, 'unsupported', prompt);
  }
});

test('laisse les questions ordinaires, les négations et les simulations commerciales au chat', () => {
  for (const prompt of ['Quelle est la date ?', 'Comment fonctionne un pendule ?', 'Explique la simulation de pendule',
    'Simule mon crédit immobilier', 'Teste le paiement de mon produit physique', 'Ne simule pas le pendule', 'Préparer un atelier de 12 places']) {
    assert.equal(scienceFromPrompt(prompt), null, prompt);
  }
});

test('seule une origine HTTPS de configuration exacte reçoit des paramètres numériques autorisés', () => {
  assert.equal(pendulumUrl('https://one.example', { lengthMeters: 0.8, angleDegrees: 12, user: 'privé' })?.href,
    'https://one.example/atelier-spatial/pendule?lengthMeters=0.8&angleDegrees=12');
  assert.equal(pendulumUrl('https://one.example/', {})?.href, 'https://one.example/atelier-spatial/pendule');
  for (const origin of [undefined, '', 'https://one.example?x=1', 'https://one.example/#fragment', 'https://user@one.example',
    'http://one.example', 'javascript:alert(1)', '//one.example', 'https://one.example/lab', 'https://one.example/../']) {
    assert.equal(pendulumUrl(origin, {}), null, String(origin));
  }
  for (const input of [{ seed: -1 }, { lengthMeters: NaN }, { samples: Infinity }, { angleDegrees: '12' }]) {
    assert.equal(pendulumUrl('https://one.example', input), null);
  }
});

test('le calcul de corrélation et la préparation du protocole ont des destinations distinctes', () => {
  for (const input of ['Compare mes deux séries numériques', 'Calcule la corrélation entre ces deux variables']) {
    assert.equal(scienceFromPrompt(input)?.kind, 'correlation');
  }
  assert.equal(scienceFromPrompt('Compare mes produits préférés'), null);
  assert.equal(scienceHandoffUrl('https://one.example', 'projet')?.pathname, '/atelier-spatial/projet');
  assert.equal(scienceHandoffUrl('https://one.example', 'correlation')?.search, '');
});

test('un reçu est numérique, borné, inerte et sépare mesure et calcul', () => {
  const report = { modelId: 'pendulum-v1', periodSeconds: 1.8, trials: 100 };
  const read = report => readPendulumReceipt({ type: 'purama:pendulum:result:v1', report });
  assert.deepEqual(read(report), { ...report, measuredPeriodSeconds: null });
  assert.equal(read({ ...report, measuredPeriodSeconds: 1.99 }).measuredPeriodSeconds, 1.99);
  for (const change of [{ modelId: '<a>' }, { periodSeconds: NaN }, { trials: 20001 }, { measuredPeriodSeconds: -1 }]) assert.equal(read({ ...report, ...change }), null);
  assert.equal(read(null), null);
  assert.equal(readPendulumReceipt({ type: 'other', report }), null);
});
