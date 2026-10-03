import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/components/voice/VoiceSettingsCard.tsx', import.meta.url),
  'utf8',
);
const helpSource = readFileSync(new URL('../src/pages/Aide.tsx', import.meta.url), 'utf8');

test('the voice test reports provider failures instead of rejecting silently', () => {
  assert.match(source, /await voice\.speak/);
  assert.match(source, /catch \(e\)/);
  assert.match(source, /toast\.error\('Test vocal impossible'/);
});

test('the help center does not display a feedback button with no action', () => {
  assert.doesNotMatch(helpSource, /ThumbsUp/);
  assert.doesNotMatch(helpSource, />\s*Utile\s*</);
});
