import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tierQueue = readFileSync(new URL('../supabase/functions/process-tier-queue/index.ts', import.meta.url), 'utf8');
const escalation = readFileSync(new URL('../supabase/functions/escalate-chat/index.ts', import.meta.url), 'utf8');
const widget = readFileSync(new URL('../src/components/ChatbotWidget.tsx', import.meta.url), 'utf8');
const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');

test('tier queue fails closed unless the configured scheduler secret matches', () => {
  assert.match(tierQueue, /Deno\.env\.get\("WEBHOOK_SECRET"\)/);
  assert.match(tierQueue, /req\.headers\.get\("x-webhook-secret"\)/);
  assert.match(tierQueue, /verifyBearerSecret/);
  assert.match(tierQueue, /status:\s*503/);
  assert.match(tierQueue, /status:\s*401/);
  assert.match(tierQueue, /req\.method !== "POST"/);
});

test('tier queue validates records and escapes dynamic email values', () => {
  assert.match(tierQueue, /isValidQueueItem\(upgrade\)/);
  assert.match(tierQueue, /escapeHtml\(data\.beneficiaryName\)/);
  assert.match(tierQueue, /escapeHtml\(data\.newRate\)/);
  assert.match(tierQueue, /escapeHtml\(data\.totalSales\)/);
});

test('chat escalation derives identity from JWT and enforces conversation ownership', () => {
  assert.match(escalation, /auth\.getUser\(match\[1\]\)/);
  assert.match(escalation, /conversation\.user_id !== authData\.user\.id/);
  assert.match(escalation, /\.eq\("user_id", authData\.user\.id\)/);
  assert.doesNotMatch(escalation, /body\.userEmail/);
  assert.match(widget, /supabase\.auth\.getSession\(\)/);
  assert.match(widget, /Bearer \$\{session\.access_token\}/);
  assert.match(config, /\[functions\.escalate-chat\]\s+verify_jwt = true/);
});

test('chat escalation validates request bounds and escapes every untrusted HTML field', () => {
  assert.match(escalation, /UUID_PATTERN\.test\(body\.conversationId\)/);
  assert.match(escalation, /body\.userMessage\.length > 5_000/);
  assert.match(escalation, /history\.length > 20/);
  assert.match(escalation, /escapeHtml\(body\.userMessage\)/);
  assert.match(escalation, /escapeHtml\(msg\.content\)/);
  assert.match(escalation, /escapeHtml\(authData\.user\.email/);
  assert.match(escalation, /catch \{\s+return json\("Invalid request", 400\);/);
  assert.match(escalation, /return json\("Internal server error", 500\)/);
  assert.doesNotMatch(escalation, /JSON\.stringify\(\{ error: e instanceof Error/);
});
