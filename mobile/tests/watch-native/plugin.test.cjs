const test = require('node:test');
const assert = require('node:assert/strict');
const { addWearSettings } = require('../../modules/purama-accessibility-watch/app.plugin.cjs');
test('Wear prebuild registration is idempotent and preserves the existing Android settings', () => {
  const original = "pluginManagement {}\ninclude ':app'\n";
  const added = addWearSettings(original); assert.ok(added.startsWith(original)); assert.equal(addWearSettings(added), added);
  assert.equal((added.match(/include ':puramaAccessibilityWatch'/g) || []).length, 1);
});
test('Wear registration refuses an unowned target and partial marker instead of overwriting it', () => {
  assert.throws(() => addWearSettings("include ':puramaAccessibilityWatch'"), /Unowned/);
  assert.throws(() => addWearSettings('// PURAMA accessibility watch — begin'), /Incomplete/);
});
