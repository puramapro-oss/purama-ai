'use strict';

const upstream = require('deepmerge-upstream');

function assertSafeConfigData(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property.enumerable) continue;
    // deepmerge 4.3.1 copies target keys by assignment. A JSON __proto__ key
    // can therefore set the returned object's prototype (GHSA-gcqx-w48m-w2h4).
    // Inspect descriptors without invoking getters; values must not change
    // between validation and the upstream merge through an accessor.
    if (key === '__proto__' || !Object.hasOwn(property, 'value')) {
      const error = new TypeError('Expo config merge requires data properties without __proto__ keys.');
      error.code = 'ERR_UNSAFE_EXPO_CONFIG_MERGE';
      throw error;
    }
    assertSafeConfigData(property.value, seen);
  }
}

function mergeConfigData(target, source, options) {
  assertSafeConfigData(target);
  assertSafeConfigData(source);
  return upstream(target, source, options);
}

mergeConfigData.all = function mergeAllConfigData(values, options) {
  assertSafeConfigData(values);
  return upstream.all(values, options);
};

module.exports = mergeConfigData;
