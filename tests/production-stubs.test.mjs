import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const footer = readFileSync(new URL('../src/components/Footer.tsx', import.meta.url), 'utf8');
const contact = readFileSync(new URL('../src/components/Contact.tsx', import.meta.url), 'utf8');
const legal = readFileSync(new URL('../src/pages/MentionsLegales.tsx', import.meta.url), 'utf8');
const privacy = readFileSync(new URL('../src/pages/PolitiqueConfidentialite.tsx', import.meta.url), 'utf8');
const referral = readFileSync(new URL('../src/pages/Parrainage.tsx', import.meta.url), 'utf8');

test('production contact surfaces use repository-backed identity data', () => {
  assert.doesNotMatch(contact, /\[À COMPLÉTER\]|Paris, France/);
  assert.match(contact, /8 rue de la Chapelle, 25560 Frasne/);
  assert.doesNotMatch(legal, /\[À COMPLÉTER - (Raison sociale|Forme juridique|Adresse du siège social|Numéro TVA|Email de contact|Numéro de téléphone)\]/);
  assert.doesNotMatch(privacy, /\[À COMPLÉTER/);
  assert.match(legal, /SASU PURAMA/);
  assert.match(privacy, /contact@purama\.fr/);
});

test('footer does not render dead social anchors', () => {
  assert.doesNotMatch(footer, /href=\{?['"]#['"]\}?/);
  assert.doesNotMatch(footer, /Twitter|Linkedin/);
});

test('referral sharing requires a real generated code', () => {
  assert.doesNotMatch(referral, /PURAMA-XXXXXXXX/);
  assert.match(referral, /disabled=\{!code\}/);
  assert.match(referral, /disabled=\{!link\}/);
  assert.match(referral, /code && link &&/);
  assert.match(referral, /await navigator\.clipboard\.writeText/);
});
