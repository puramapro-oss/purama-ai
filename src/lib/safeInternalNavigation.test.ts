import { describe, expect, it } from 'vitest';
import { safeInternalPath } from './safeNavigation';

describe('safeInternalPath', () => {
  it.each([
    ['/dashboard', '/dashboard'],
    ['/notifications?filter=alert#latest', '/notifications?filter=alert#latest'],
    ['/dashboard/../notifications', '/notifications'],
    ['/recherche?q=%C3%A9ch%C3%A9ance', '/recherche?q=%C3%A9ch%C3%A9ance'],
  ])('accepte et normalise une route interne %s', (input, expected) => {
    expect(safeInternalPath(input)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    '',
    ' /dashboard',
    'dashboard',
    'https://evil.example/phishing',
    '//evil.example/phishing',
    '/\\evil.example/phishing',
    '\\evil.example\\phishing',
    '/dashboard\\settings',
    '/%5cevil.example',
    '/%255cevil.example',
    '/%2f%2fevil.example',
    '/%252f%252fevil.example',
    '/%0ajavascript:alert(1)',
    '/%E0%A4%A',
  ])('refuse une cible ambiguë ou externe: %s', (input) => {
    expect(safeInternalPath(input)).toBeNull();
  });
});
