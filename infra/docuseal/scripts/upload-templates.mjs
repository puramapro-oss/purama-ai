#!/usr/bin/env node
// Upload the 8 Purama contract templates to DocuSeal.
// Idempotent: checks existing templates and updates if slug already present.
// Usage: DOCUSEAL_API_URL=... DOCUSEAL_API_TOKEN=... node upload-templates.mjs
//        or via npm: npm run docuseal:upload-templates

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', 'templates');

const DOCUSEAL_API_URL = process.env.DOCUSEAL_API_URL ?? 'https://docuseal.purama.dev';
const DOCUSEAL_API_TOKEN = process.env.DOCUSEAL_API_TOKEN;
const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? 'https://auth.purama.dev';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!DOCUSEAL_API_TOKEN) { console.error('DOCUSEAL_API_TOKEN required'); process.exit(1); }
if (!SUPABASE_SERVICE_ROLE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1); }

// ─── Template definitions (tier-aware for ambassadeur) ──────────────────
const TEMPLATES = [
  // Ambassadeur tiers — share ambassadeur.html, vary tier_label + commission_rate + duration_months
  { slug: 'ambassadeur-bronze',  file: 'ambassadeur.html',          name: 'Ambassadeur Bronze',  tier: 'bronze',  rate: 10, months: 12 },
  { slug: 'ambassadeur-argent',  file: 'ambassadeur.html',          name: 'Ambassadeur Argent',  tier: 'argent',  rate: 15, months: 12 },
  { slug: 'ambassadeur-or',      file: 'ambassadeur.html',          name: 'Ambassadeur Or',      tier: 'or',      rate: 20, months: 12 },
  { slug: 'ambassadeur-platine', file: 'ambassadeur.html',          name: 'Ambassadeur Platine', tier: 'platine', rate: 25, months: 24 },
  { slug: 'ambassadeur-eternel', file: 'ambassadeur.html',          name: 'Ambassadeur Éternel (héréditaire)', tier: 'eternel', rate: 30, months: 1200 },
  // Business contracts
  { slug: 'partenariat-business', file: 'partenariat-business.html', name: 'Partenariat Business', tier: null, rate: null, months: 12 },
  { slug: 'territoire-purama',    file: 'territoire-purama.html',    name: 'Convention Territoire Purama', tier: null, rate: null, months: 36 },
  { slug: 'prestation-freelance', file: 'prestation-freelance.html', name: 'Contrat Prestation Freelance', tier: null, rate: null, months: 3 },
];

const TIER_LABELS = { bronze: 'Bronze', argent: 'Argent', or: 'Or', platine: 'Platine', eternel: 'Éternel' };

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

async function docuseal(method, path, body) {
  const res = await fetch(`${DOCUSEAL_API_URL}${path}`, {
    method,
    headers: { 'X-Auth-Token': DOCUSEAL_API_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`DocuSeal ${method} ${path} → ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

async function supabase(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'purama_ai',
      'Content-Profile': 'purama_ai',
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${txt.slice(0, 500)}`);
  }
  return res.status === 204 ? null : res.json();
}

function renderHtml(html, vars) {
  return html.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) =>
    vars[key] !== undefined ? String(vars[key]) : `{{${key}}}`
  );
}

async function main() {
  log(`DocuSeal target: ${DOCUSEAL_API_URL}`);

  // 1. List existing templates (idempotency — update if slug exists)
  const existing = await docuseal('GET', '/api/templates?limit=100');
  const existingByName = new Map();
  for (const t of existing.data ?? []) existingByName.set(t.name, t.id);
  log(`Found ${existingByName.size} existing DocuSeal templates`);

  const results = [];

  for (const tpl of TEMPLATES) {
    const filePath = join(TEMPLATES_DIR, tpl.file);
    let html = readFileSync(filePath, 'utf8');

    // For ambassadeur slugs sharing the same HTML file, bake tier-specific vars
    if (tpl.tier) {
      html = renderHtml(html, {
        tier_label: TIER_LABELS[tpl.tier],
        commission_rate: tpl.rate,
        duration_months: tpl.months,
        contract_reference: `PURAMA-${tpl.slug.toUpperCase()}`,
      });
    }

    // Create or update
    const docusealName = `Purama — ${tpl.name}`;
    let docusealId = existingByName.get(docusealName);

    if (docusealId) {
      log(`↻ UPDATE ${tpl.slug} (DocuSeal #${docusealId}) — delete + recreate (HTML change)`);
      try { await docuseal('DELETE', `/api/templates/${docusealId}`); } catch (e) { log(`  delete warn: ${e.message}`); }
      docusealId = null;
    }

    if (!docusealId) {
      log(`↑ CREATE ${tpl.slug}`);
      const created = await docuseal('POST', '/api/templates/html', {
        html,
        name: docusealName,
        external_id: tpl.slug,
      });
      docusealId = created.id;
      log(`  → DocuSeal template_id=${docusealId}`);
    }

    // Upsert in purama_ai.contract_templates
    await supabase('POST', '/contract_templates', {
      slug: tpl.slug,
      version: 1,
      name: tpl.name,
      description: `Template ${tpl.name} — DocuSeal ID ${docusealId}`,
      html_template: '(stored in DocuSeal — see docuseal_template_id)',
      variables: [],
      tier_required: tpl.tier,
      docuseal_template_id: docusealId,
      active: true,
    });

    results.push({ slug: tpl.slug, docuseal_id: docusealId });
  }

  log('');
  log('=== RESULTS ===');
  for (const r of results) log(`  ${r.slug.padEnd(28)} → DocuSeal #${r.docuseal_id}`);
  log('');
  log(`✅ ${results.length}/${TEMPLATES.length} templates uploaded + synced to purama_ai.contract_templates`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(2); });
