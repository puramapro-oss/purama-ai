import { test, expect } from '@playwright/test';
import {
  CreateContractInputSchema,
  CrossAppJwtPayloadSchema,
  WebhookPayloadSchema,
} from '../../src/lib/docuseal/types';

const validContract = {
  user_id: '00000000-0000-4000-8000-000000000001',
  app_slug: 'purama-ai',
  template_slug: 'test-contract',
  signer: { email: 'fixture@example.invalid', name: 'Contract fixture' },
};

test('contract validation preserves defaults and arbitrary metadata after Zod migration', () => {
  expect(CreateContractInputSchema.parse(validContract)).toMatchObject({ metadata: {}, dual_signer: true });
  expect(CreateContractInputSchema.parse({
    ...validContract, metadata: { nested: { accepted: true }, amount: 25 }, variables: { first_name: 'Fixture' },
  })).toMatchObject({ metadata: { nested: { accepted: true }, amount: 25 }, variables: { first_name: 'Fixture' } });
});

test('contract validation rejects malformed identifiers, contacts, and variable values', () => {
  for (const patch of [
    { user_id: 'not-a-uuid' },
    { signer: { name: 'Fixture', email: 'invalid-address' } },
    { app_slug: 'a'.repeat(65) },
    { variables: { number: 42 } },
  ]) {
    expect(CreateContractInputSchema.safeParse({ ...validContract, ...patch }).success).toBe(false);
  }
});

test('webhook validation requires a record and retains provider payload values', () => {
  expect(WebhookPayloadSchema.parse({ event_type: 'form.completed', data: { id: 42, signed: true } }).data)
    .toEqual({ id: 42, signed: true });
  for (const data of [null, undefined, [], 'payload']) {
    expect(WebhookPayloadSchema.safeParse({ event_type: 'form.completed', data }).success).toBe(false);
  }
});

test('cross-application claims require the contracts-hub audience and finite timestamps', () => {
  const claims = { iss: 'fixture', aud: 'purama-contracts-hub', app_slug: 'purama-ai', iat: 1, exp: 2 };
  expect(CrossAppJwtPayloadSchema.safeParse(claims).success).toBe(true);
  expect(CrossAppJwtPayloadSchema.safeParse({ ...claims, aud: 'other-service' }).success).toBe(false);
  expect(CrossAppJwtPayloadSchema.safeParse({ ...claims, exp: Infinity }).success).toBe(false);
});
