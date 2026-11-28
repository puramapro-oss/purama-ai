import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import i18next from 'i18next';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider, initReactI18next, useTranslation } from 'react-i18next';

// Exercise the dependency contracts used by src/i18n/index.ts with the actual
// bundled translations. Browser interaction is covered by the browser suites.
const localeDirectory = new URL('../src/i18n/locales/', import.meta.url);
const localeFiles = (await readdir(localeDirectory))
  .filter((name) => name.endsWith('.json'))
  .sort();
const bundledResources = Object.fromEntries(await Promise.all(localeFiles.map(async (name) => [
  name.slice(0, -5),
  { translation: JSON.parse(await readFile(new URL(name, localeDirectory), 'utf8')) },
])));

async function createTranslator(resources, lng = 'fr', plugins = []) {
  const instance = i18next.createInstance();
  for (const plugin of plugins) instance.use(plugin);
  await instance.init({
    resources: structuredClone(resources),
    lng,
    fallbackLng: 'fr',
    defaultNS: 'translation',
    interpolation: { escapeValue: false },
  });
  return instance;
}

test('bundled French and English resources support repeated language changes', async () => {
  const instance = await createTranslator({
    fr: bundledResources.fr,
    en: bundledResources.en,
  });
  assert.equal(instance.t('common.loading'), 'Chargement...');
  await instance.changeLanguage('en');
  assert.equal(instance.t('common.loading'), 'Loading...');
  assert.equal(instance.t('settings.language'), 'Language');
  await instance.changeLanguage('fr');
  assert.equal(instance.t('common.loading'), 'Chargement...');
  assert.equal(instance.t('common.save'), 'Sauvegarder');
});

test('every additional bundled locale can be loaded and selected without losing its text', async () => {
  const instance = await createTranslator({
    fr: bundledResources.fr,
    en: bundledResources.en,
  });
  const additionalLocales = Object.entries(bundledResources)
    .filter(([lng]) => lng !== 'fr' && lng !== 'en');
  assert.ok(additionalLocales.length > 0);
  for (const [lng, resource] of additionalLocales) {
    assert.equal(instance.hasResourceBundle(lng, 'translation'), false, lng);
    instance.addResourceBundle(lng, 'translation', structuredClone(resource.translation), true, true);
    await instance.changeLanguage(lng);
    assert.equal(instance.resolvedLanguage, lng);
    for (const [group, key] of [['common', 'loading'], ['nav', 'home'], ['settings', 'language']]) {
      assert.equal(typeof resource.translation[group][key], 'string', `${lng}:${group}.${key}`);
      assert.equal(instance.t(`${group}.${key}`), resource.translation[group][key], `${lng}:${group}.${key}`);
    }
  }
});

test('missing translations and regional locale tags retain the French fallback', async () => {
  const instance = await createTranslator({
    fr: bundledResources.fr,
    en: { translation: { common: { save: 'Save' } } },
  }, 'en');
  assert.equal(instance.t('common.save'), 'Save');
  assert.equal(instance.t('common.cancel'), 'Annuler');
  await instance.changeLanguage('fr-CA');
  assert.equal(instance.resolvedLanguage, 'fr');
  assert.equal(instance.t('common.save'), 'Sauvegarder');
  await instance.changeLanguage('zz');
  assert.equal(instance.resolvedLanguage, 'fr');
  assert.equal(instance.t('common.cancel'), 'Annuler');
});

test('ordinary interpolation preserves values and supports explicit escaping', async () => {
  const instance = await createTranslator({
    fr: { translation: { greeting: 'Bonjour {{name}}, projet {{project.title}}.', value: '{{value}}' } },
  });
  assert.equal(instance.t('greeting', { name: 'Matiss', project: { title: 'IAO' } }), 'Bonjour Matiss, projet IAO.');
  assert.equal(instance.t('value', { value: 'A & B' }), 'A & B');
  assert.equal(instance.t('value', { value: 'A & B', interpolation: { escapeValue: true } }), 'A &amp; B');
});

test('plural selection supports English and all Arabic plural categories', async () => {
  const instance = await createTranslator({
    en: { translation: { item_one: '{{count}} item', item_other: '{{count}} items' } },
    ar: { translation: {
      item_zero: 'zero {{count}}',
      item_one: 'one {{count}}',
      item_two: 'two {{count}}',
      item_few: 'few {{count}}',
      item_many: 'many {{count}}',
      item_other: 'other {{count}}',
    } },
  }, 'en');
  assert.equal(instance.t('item', { count: 1 }), '1 item');
  assert.equal(instance.t('item', { count: 2 }), '2 items');
  assert.equal(instance.t('item', { count: 0 }), '0 items');
  await instance.changeLanguage('ar');
  for (const [count, category] of [[0, 'zero'], [1, 'one'], [2, 'two'], [3, 'few'], [11, 'many'], [100, 'other']]) {
    assert.equal(instance.t('item', { count }), `${category} ${count}`);
  }
});

test('ordinary deep resource updates preserve siblings and replace intended values', async () => {
  const instance = await createTranslator({ fr: { translation: {
    common: { save: 'Ancien', cancel: 'Annuler' },
    panel: { title: 'Titre', navigation: { home: 'Accueil' } },
  } } });
  instance.addResourceBundle('fr', 'translation', {
    common: { save: 'Sauvegarder', download: 'Télécharger' },
    panel: { navigation: { back: 'Retour' } },
  }, true, true);
  assert.equal(instance.t('common.save'), 'Sauvegarder');
  assert.equal(instance.t('common.cancel'), 'Annuler');
  assert.equal(instance.t('common.download'), 'Télécharger');
  assert.equal(instance.t('panel.title'), 'Titre');
  assert.equal(instance.t('panel.navigation.home'), 'Accueil');
  assert.equal(instance.t('panel.navigation.back'), 'Retour');
});

test('react-i18next renders the active language through its provider and hook', async () => {
  const instance = await createTranslator({
    fr: bundledResources.fr,
    en: bundledResources.en,
  }, 'fr', [initReactI18next]);
  function LoadingText() {
    const { t } = useTranslation();
    return React.createElement('span', null, t('common.loading'));
  }
  const render = () => renderToStaticMarkup(React.createElement(
    I18nextProvider,
    { i18n: instance },
    React.createElement(LoadingText),
  ));
  assert.equal(render(), '<span>Chargement...</span>');
  await instance.changeLanguage('en');
  assert.equal(render(), '<span>Loading...</span>');
});
