import DOMPurify, { type Config } from 'dompurify';

const EMAIL_HTML_CONFIG: Config = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'a'],
  ALLOWED_ATTR: ['href', 'title'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

/**
 * Sanitizes persisted/generated email HTML before rendering it in the app.
 *
 * Email drafts are intentionally restricted to the same small HTML subset
 * requested from the drafting service. DOMPurify also rejects unsafe URL
 * schemes (for example `javascript:`) in allowed link attributes.
 */
export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, EMAIL_HTML_CONFIG);
}
