// DocuSeal lib — public API
// Used by React components (src/pages, src/components) and Edge Functions (_shared imports).

export {
  DocusealClient,
  DocusealError,
  createDocusealClient,
  type DocusealClientConfig,
} from './client';

export {
  CONTRACT_TEMPLATES,
  getTemplate,
  getAllTemplates,
  getAmbassadeurTemplates,
  type TemplateMetadata,
} from './templates';

export {
  renderTemplate,
  sanitizeVariables,
  escapeHtml,
  buildAmbassadeurVariables,
  type RenderVariables,
} from './pdf-generator';

export {
  verifyWebhookSignature,
  normalizeWebhookEvent,
  type NormalizedWebhookEvent,
} from './webhook-validator';

export {
  signCrossAppJwt,
  verifyCrossAppJwt,
} from './cross-app-auth';

export {
  stampContract,
  verifyContractProof,
  type StampResult,
} from './ots-stamper';

export {
  AMBASSADEUR_TIERS,
  CreateContractInputSchema,
  WebhookPayloadSchema,
  CrossAppJwtPayloadSchema,
  type Contract,
  type ContractSigner,
  type ContractStatus,
  type ContractEventType,
  type SignerRole,
  type AmbassadeurTier,
  type DocusealTemplate,
  type DocusealSubmitter,
  type DocusealSubmission,
  type DocusealWebhookPayload,
  type CreateContractInput,
  type CrossAppJwtPayload,
} from './types';
