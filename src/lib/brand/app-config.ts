// ─── Purama · App config (seed + slug) ───────────────────────────────────
// Lu depuis .env côté Vite : VITE_PALETTE_SEED + VITE_APP_SLUG.

export const APP_SEED = (import.meta.env?.VITE_PALETTE_SEED as string | undefined) ?? 'tech-cyber-purama-ai';
export const APP_SLUG = (import.meta.env?.VITE_APP_SLUG as string | undefined) ?? 'purama-ai';

// ShaderVariant global (hero/ambient/celebrate/focus). Chaque composant peut override.
export const DEFAULT_SHADER_VARIANT = 'hero' as const;
