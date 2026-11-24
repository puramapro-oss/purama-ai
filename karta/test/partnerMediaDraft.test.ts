import { describe, expect, it } from 'vitest';

const helperUrl = new URL('../../supabase/functions/partner-send-outreach/media-draft.ts', import.meta.url).href;
const handlerUrl = new URL('../../supabase/functions/partner-send-outreach/handler.ts', import.meta.url).href;
const { buildMediaOutreachDraft, MediaDraftError } = await import(/* @vite-ignore */ helperUrl);
const { createPartnerOutreachHandler } = await import(/* @vite-ignore */ handlerUrl);
type Row = Record<string, unknown>;
const user = '00000000-0000-4000-8000-000000000001';
const prospectId = '00000000-0000-4000-8000-000000000011';
const actionId = '00000000-0000-4000-8000-000000000021';
const token = '00000000-0000-4000-8000-000000000031';
const emailId = '00000000-0000-4000-8000-000000000041';
const offer = { name: 'Offre de recette', url: 'https://shop.example.invalid/product?a=1&b=2',
  summary: 'Une présentation factuelle choisie par le propriétaire de cette fixture.' };
const cfg: Row = { company_name: 'Entreprise de recette', sender_name: 'Responsable de recette',
  sender_email: 'sender@example.invalid', outreach_identity_mode: 'assistant',
  require_approval_outreach: false, commission_first_payment: 50, commission_recurring: 10 };
const prospect: Row = { id: prospectId, name: 'Rédaction de recette', outreach_profile: 'media_affiliate',
  contact_role: 'commercial', contact_qualification: { language: 'fr-CH' }, outreach_offer: offer };

function harness(prospectPatch: Row = {}, configPatch: Row = {}, migrationPresent = true) {
  const calls: Array<{ url: string; body: Row }> = [];
  const outcomes: unknown[] = [];
  let draft: Row = {};
  const config = { ...cfg, ...configPatch };
  const handler = createPartnerOutreachHandler({
    authenticate: async (auth: string) => auth === 'fixture-user' ? user : null,
    newClaimToken: () => token, anthropicApiKey: '', resendApiKey: 'fixture-provider-key',
    rpc: async (name: string, args: Row) => {
      if (name === 'partner_outreach_reserve') return { error: null, data: {
        action_id: actionId, claimed: true, status: 'preparing', prospect: { ...prospect, ...prospectPatch }, config,
      } };
      if (name === 'partner_outreach_save_draft') {
        draft = { subject: args.p_subject, html: args.p_body_html, to: 'recipient@example.invalid',
          from: 'IAO — Entreprise de recette <sender@example.invalid>', reply_to: 'sender@example.invalid' };
        return { error: null, data: { action_id: actionId, email_id: emailId, claimed: true,
          status: config.require_approval_outreach ? 'pending_approval' : 'ready' } };
      }
      if (name === 'partner_outreach_begin_send') return { error: null, data: {
        action_id: actionId, email_id: emailId, status: 'sending', claimed: true, payload: draft,
        policy_snapshot: migrationPresent ? { version: '20261124' } : undefined,
        idempotency_key: `partner-outreach/${actionId}`,
      } };
      if (name === 'partner_outreach_finish') {
        outcomes.push(args.p_outcome);
        return { error: null, data: { status: args.p_outcome, email_id: emailId, provider_message_id: args.p_provider_message_id } };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
    fetch: async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url !== 'https://api.resend.com/emails') throw new Error('No model or other provider is permitted in this fixture');
      return Response.json({ id: 'fixture-provider-receipt' });
    },
  });
  return { calls, outcomes, run: async () => {
    const response = await handler(new Request('https://service.example.invalid/outreach', {
      method: 'POST', headers: { Authorization: 'Bearer fixture-user', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prospect_id: prospectId }),
    }));
    return { ...await response.json(), http_status: response.status } as Row;
  } };
}

describe('media outreach facts and identity', () => {
  it('keeps the media rate at 30% despite historical account rates, and renders the verified offer', () => {
    const result = buildMediaOutreachDraft(prospect, cfg, 'outreach')!;
    expect(result.body_html).toContain('30 %');
    expect(result.body_html).not.toMatch(/50\s*%|10\s*%/);
    expect(result.body_html).toContain(offer.summary);
    expect(result.body_html).toContain('hors taxes après remises et remboursements, avant frais de paiement');
    expect(result.body_html).toContain('Aucun revenu minimum');
    expect(result.body_html).toContain('assistant IA');
    expect(result.body_html).toContain('répondez simplement');
    expect(result.subject).not.toMatch(/^Re:/i);
  });

  it('offers independent coverage to an editorial desk without a commission promise', () => {
    const result = buildMediaOutreachDraft({ ...prospect, outreach_profile: 'editorial', contact_role: 'editorial' }, cfg, 'outreach')!;
    expect(result.body_html).toContain('liberté de traitement');
    expect(result.body_html).not.toMatch(/30\s*%|commission|minimum/);
  });

  it.each([
    ['fr-CH', 'Bonjour', 'assistant IA'], ['en-GB', 'Hello', 'AI partnerships assistant'],
    ['de-CH', 'Guten Tag', 'KI-Assistent'], ['es-MX', 'Hola', 'asistente de IA'],
    ['it-CH', 'Buongiorno', 'assistente IA'], ['pt-BR', 'Olá', 'assistente de IA'],
  ])('uses the qualified locale %s and discloses the assistant identity', (language, greeting, identity) => {
    const result = buildMediaOutreachDraft({ ...prospect, contact_qualification: { language } }, cfg, 'outreach')!;
    expect(result.body_html).toContain(greeting);
    expect(result.body_html).toContain(identity);
    expect(result.body_html).toContain(offer.summary);
  });

  it('escapes untrusted product facts and names instead of executing embedded HTML', () => {
    const result = buildMediaOutreachDraft({ ...prospect, name: '<img src=x onerror=alert(1)>',
      outreach_offer: { ...offer, name: '<script>bad()</script>', summary: '<svg onload=alert(1)>Offer facts</svg>' } }, cfg, 'outreach')!;
    expect(result.body_html).not.toMatch(/<script|<svg|<img/);
    expect(result.body_html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(result.body_html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(result.body_html).toContain('a=1&amp;b=2');
  });

  it.each(['http://shop.example.invalid', 'javascript:alert(1)', 'https://user:secret@shop.example.invalid',
    'https://shop.example.invalid/a\r\nBcc:bad', 'https:\\shop.example.invalid/product'])('rejects unsafe product URL %s', (url) => {
    expect(() => buildMediaOutreachDraft({ ...prospect, outreach_offer: { ...offer, url } }, cfg, 'outreach'))
      .toThrowError(new MediaDraftError('offer_required'));
  });

  it.each([{ ...offer, name: 42 }, { ...offer, summary: [] }, { ...offer, summary: 'short' },
    { ...offer, name: 'Offer\nInjected subject' }])('rejects unqualified product facts', (badOffer) => {
    expect(() => buildMediaOutreachDraft({ ...prospect, outreach_offer: badOffer }, cfg, 'outreach'))
      .toThrowError(new MediaDraftError('offer_required'));
  });

  it('does not silently replace an unsupported language with French', () => {
    expect(() => buildMediaOutreachDraft({ ...prospect, contact_qualification: { language: 'ja' } }, cfg, 'outreach'))
      .toThrowError(new MediaDraftError('outreach_language_unsupported'));
  });

  it('keeps the legacy pipeline separate and rejects editorial/commercial mismatches', () => {
    expect(buildMediaOutreachDraft({ ...prospect, outreach_profile: 'legacy' }, cfg, 'outreach')).toBeNull();
    expect(() => buildMediaOutreachDraft({ ...prospect, contact_role: 'editorial' }, cfg, 'outreach'))
      .toThrowError(new MediaDraftError('campaign_role_mismatch'));
    expect(() => buildMediaOutreachDraft({ ...prospect, contact_role: 'unknown' }, cfg, 'outreach'))
      .toThrowError(new MediaDraftError('contact_role_required'));
  });

  it('bounds follow-ups at two and keeps human identity behind actual review', () => {
    expect(() => buildMediaOutreachDraft(prospect, cfg, 'relance_3'))
      .toThrowError(new MediaDraftError('media_followup_limit'));
    expect(() => buildMediaOutreachDraft(prospect, { ...cfg, outreach_identity_mode: 'human_reviewed' }, 'outreach'))
      .toThrowError(new MediaDraftError('human_review_required'));
    const result = buildMediaOutreachDraft(prospect, { ...cfg, outreach_identity_mode: 'human_reviewed', require_approval_outreach: true }, 'outreach')!;
    expect(result.body_html).toContain(String(cfg.sender_name));
    expect(result.body_html).not.toContain('Je suis IAO');
  });
});

describe('media sender integration without external network', () => {
  it('prepares and sends the factual media payload without a model key or model request', async () => {
    const h = harness();
    expect(await h.run()).toMatchObject({ status: 'sent', message_id: 'fixture-provider-receipt' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body.html).toContain('30 %');
    expect(h.outcomes).toEqual(['sent']);
  });

  it('blocks a partial database rollout before any provider request', async () => {
    const h = harness({}, {}, false);
    expect(await h.run()).toMatchObject({ status: 'blocked', reason: 'outreach_policy_migration_required' });
    expect(h.calls).toEqual([]);
    expect(h.outcomes).toEqual(['failed']);
  });

  it('returns a visible unsupported-language reason and never sends a fallback message', async () => {
    const h = harness({ contact_qualification: { language: 'ja' } });
    expect(await h.run()).toMatchObject({ status: 'blocked', reason: 'outreach_language_unsupported' });
    expect(h.calls).toEqual([]);
    expect(h.outcomes).toEqual(['failed']);
  });

  it('retains the approval gate for a message signed by the real human sender', async () => {
    const h = harness({}, { outreach_identity_mode: 'human_reviewed', require_approval_outreach: true });
    expect(await h.run()).toMatchObject({ status: 'pending_approval' });
    expect(h.calls).toEqual([]);
    expect(h.outcomes).toEqual([]);
  });
});
