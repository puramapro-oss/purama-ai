import { afterEach, expect, it, vi } from 'vitest';
import { buildAmbassadeurVariables } from './pdf-generator';

const sample = {
  userFullName: 'Personne test', userEmail: 'personne@example.invalid',
  userAddress: 'Adresse test', userCity: 'Ville test', userPostalCode: '00000',
  userCountry: 'France', userIban: 'test', commissionRate: 10,
};

afterEach(() => { vi.useRealTimers(); });

it.each([
  [2026, 1, 31, 1, '28 février 2026'],
  [2024, 1, 31, 1, '29 février 2024'],
  [2024, 2, 29, 12, '28 février 2025'],
  [2026, 12, 15, 1, '15 janvier 2027'],
] as const)('calcule la date de fin pour %i-%i-%i avec une durée de %i mois', (year, month, day, durationMonths, expected) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(year, month - 1, day, 12));
  expect(buildAmbassadeurVariables({ ...sample, durationMonths }).end_date).toBe(expected);
});
