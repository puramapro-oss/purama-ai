import { describe, expect, it } from 'vitest';
import { safeInternalPath } from './safeNavigation';

describe('safeInternalPath', () => {
  it.each([
    ['/dashboard', '/dashboard'],
    ['/dashboard?tab=billing#usage', '/dashboard?tab=billing#usage'],
    ['/mes-connexions', '/mes-connexions'],
  ])('accepts an internal path %s', (value, expected) => {
    expect(safeInternalPath(value)).toBe(expected);
  });

  it.each([
    'https://evil.example/path',
    '//evil.example/path',
    '/\\evil.example/path',
    '/%5cevil.example/path',
    '/%2f%2fevil.example/path',
    '/safe\nunsafe',
    'dashboard',
    null,
    { pathname: '/dashboard' },
  ])('rejects an untrusted destination %j', (value) => {
    expect(safeInternalPath(value, '/fallback')).toBe('/fallback');
  });
});
