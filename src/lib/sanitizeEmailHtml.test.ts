// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml } from './sanitizeEmailHtml';

describe('sanitizeEmailHtml', () => {
  it('preserves the supported email formatting', () => {
    const html = '<p>Bonjour<br><strong>Partenaire</strong> <a href="https://purama.dev" title="PURAMA">Découvrir</a></p>';

    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it('removes executable elements, event handlers and styles', () => {
    const html = '<p style="color:red" onclick="alert(1)">Bonjour<script>alert(2)</script><img src=x onerror="alert(3)"></p>';

    expect(sanitizeEmailHtml(html)).toBe('<p>Bonjour</p>');
  });

  it('removes unsafe link schemes while retaining safe links', () => {
    const html = '<p><a href="javascript:alert(1)">Piège</a><a href="mailto:hello@purama.dev">Contact</a></p>';

    expect(sanitizeEmailHtml(html)).toBe('<p><a>Piège</a><a href="mailto:hello@purama.dev">Contact</a></p>');
  });

  it('unwraps unsupported formatting without losing its text', () => {
    expect(sanitizeEmailHtml('<div>Texte <em>important</em></div>')).toBe('Texte important');
  });
});
