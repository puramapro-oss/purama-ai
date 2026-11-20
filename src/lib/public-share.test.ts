import { describe, expect, it } from 'vitest';
import { buildPublicShareUrl } from './public-share';

const origin = 'https://purama.example';
const template = '/modeles/a6211822-fc3c-4c77-854a-3bc79dd4405d';

describe('buildPublicShareUrl', () => {
  it('utilise l’accueil public si aucun chemin n’est fourni', () => {
    expect(buildPublicShareUrl({ origin })).toBe(origin + '/');
  });

  it.each(['/', '/forge', '/ecosystem', '/parrainage', '/purama-compta', template])(
    'accepte uniquement une destination publique définie : %s',
    (path) => expect(buildPublicShareUrl({ origin, path })).toBe(origin + path),
  );

  it('conserve uniquement le code de recommandation explicitement fourni', () => {
    const url = new URL(buildPublicShareUrl({ origin, path: template, referralCode: 'partner_A-42' })!);
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe(template);
    expect([...url.searchParams]).toEqual([['ref', 'partner_A-42']]);
    expect(url.hash).toBe('');
  });

  it.each([
    '', 'forge', '/signup', '/login', '/dashboard', '/dashboard/creator-agent/templates',
    '/go/affiliate', '/modeles/not-a-uuid', '/modeles/a6211822-fc3c-4c77-854a-3bc79dd4405d/private',
    '/forge/', '/Forge', '/forge?ref=code', '/forge?access_token=secret', '/forge#private',
    '/modeles/a6211822-fc3c-4c77-854a-3bc79dd4405d\n',
    ' /forge', '/forge ', '/forge\n', '/forge\t', '/forge/../ecosystem',
    '/%66orge', '/%2566orge', '/forge%3Ftoken=secret', '/forge%23secret',
    '//evil.example/forge', 'https://evil.example/forge', 'https://purama.example/forge',
    '/\\evil.example/forge', '\\forge', 'javascript:alert(1)', '/forge\0',
  ])('refuse une cible privée, ambiguë ou accompagnée de données : %s', (path) => {
    expect(buildPublicShareUrl({ origin, path })).toBeNull();
  });

  it.each([
    '', ' partner', 'partner ', 'partner\n', 'ref&secret=value', 'ref?secret=value',
    'ref#secret', 'ref=value', 'ref%26secret', 'équipe', 'a'.repeat(65),
  ])('refuse un code invalide sans en inventer un autre : %s', (referralCode) => {
    expect(buildPublicShareUrl({ origin, referralCode })).toBeNull();
  });

  it.each(['http://localhost', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://[::1]:4173'])(
    'permet le développement HTTP sur une origine locale explicite : %s',
    (localOrigin) => expect(buildPublicShareUrl({ origin: localOrigin, path: '/forge' })).toBe(localOrigin + '/forge'),
  );

  it.each([
    '', 'null', 'https://purama.example/', 'https://purama.example/forge',
    'https://purama.example?token=secret', 'https://purama.example#secret',
    'https://user:password@purama.example', 'http://purama.example',
    'http://localhost.evil.example', 'http://192.168.1.2', '//purama.example',
    'file:///workspace', 'javascript:alert(1)', ' https://purama.example',
    'https://purama.example\n', 'https://purama.example\\private', 'https://purama.example:443',
  ])('refuse une origine incertaine, privée ou non sécurisée : %s', (invalidOrigin) => {
    expect(buildPublicShareUrl({ origin: invalidOrigin })).toBeNull();
  });

  it('refuse aussi des entrées incorrectes reçues à l’exécution', () => {
    const build = buildPublicShareUrl as (input: { origin: unknown; path?: unknown; referralCode?: unknown }) => string | null;
    expect(build({ origin: null })).toBeNull();
    expect(build({ origin, path: null })).toBeNull();
    expect(build({ origin, path: ['/forge'] })).toBeNull();
    expect(build({ origin, referralCode: null })).toBeNull();
    expect(build({ origin, referralCode: 42 })).toBeNull();
  });
});
