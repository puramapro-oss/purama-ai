import { createEmailAgentRuntime } from '../_shared/email-agent-runtime.ts';
import { createPartnerReplyDraftHandler } from './handler.ts';

Deno.serve(createPartnerReplyDraftHandler(createEmailAgentRuntime()));
