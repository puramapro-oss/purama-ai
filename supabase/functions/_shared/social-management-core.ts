// Account/settings handlers. Provider IDs never come from request bodies.
export interface ManagedSocialAccount {
  id: string;
  user_id: string;
  platform: string;
  zernio_account_id: string;
  zernio_profile_id: string;
  publishing_verified_at: string | null;
  is_active: boolean;
  disconnect_pending?: boolean;
  disconnect_reconcile_ready?: boolean;
  disconnect_completed_at?: string | null;
  [key: string]: unknown;
}
export interface SocialProfileBinding {
  user_id: string;
  zernio_profile_id: string | null;
  creation_status: string;
}
export interface AccountStore {
  list(userId: string): Promise<ManagedSocialAccount[]>;
  find(userId: string, platform: string): Promise<ManagedSocialAccount | null>;
  binding(userId: string): Promise<SocialProfileBinding | null>;
  // Compare the binding snapshot: OAuth can replace it during a disconnect.
  deactivate(account: ManagedSocialAccount): Promise<boolean>;
  allowDisconnectReconciliation(account: ManagedSocialAccount): Promise<boolean>;
  finishDisconnect(account: ManagedSocialAccount): Promise<boolean>;
}
export interface SocialConfig {
  user_id: string;
  autopilot_enabled: boolean;
  auto_caption: boolean;
  auto_hashtags: boolean;
  default_platforms: string[];
  timezone: string;
  updated_at?: string | null;
}
export class SocialConfigurationConflict extends Error {}
export interface ConfigStore {
  read(userId: string): Promise<SocialConfig | null>;
  write(config: SocialConfig, previous: SocialConfig | null): Promise<SocialConfig>;
  verifiedPlatforms(userId: string): Promise<string[]>;
}
interface AuthDeps {
  authenticate(token: string): Promise<{ id: string } | null>;
  corsHeaders: Record<string, string>;
  platforms: readonly string[];
}
export interface AccountDeps extends AuthDeps {
  store: AccountStore;
  verifyAccount(binding: { profileId: string; accountId: string; platform: string }): Promise<unknown>;
  confirmAccountAbsent(binding: { profileId: string; accountId: string }): Promise<boolean>;
  disconnectAccount(accountId: string): Promise<unknown>;
}
export interface ConfigDeps extends AuthDeps { store: ConfigStore }
function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
async function identity(req: Request, deps: AuthDeps) {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '')?.[1];
  return token ? await deps.authenticate(token) : null;
}
export async function handleSocialAccountsRequest(req: Request, deps: AccountDeps): Promise<Response> {
  const reply = (body: unknown, status = 200) => json(body, status, deps.corsHeaders);
  if (req.method === 'OPTIONS') return new Response(null, { headers: deps.corsHeaders });
  if (!['GET', 'DELETE'].includes(req.method)) return reply({ error: 'Method not allowed' }, 405);
  try {
    const user = await identity(req, deps);
    if (!user) return reply({ error: 'Unauthorized' }, 401);
    if (req.method === 'GET') return reply(await deps.store.list(user.id));
    const platform = new URL(req.url).searchParams.get('platform');
    if (!platform || !deps.platforms.includes(platform)) return reply({ error: 'Plateforme non prise en charge' }, 400);
    const account = await deps.store.find(user.id, platform);
    if (!account) return reply({ success: true, already_absent: true, provider_disconnected: false });
    if (account.user_id !== user.id || account.platform !== platform) return reply({ error: 'Compte social incohérent' }, 409);
    const partial = (providerConfirmed = false) => reply({
      success: false, local_disconnected: true, provider_disconnected: providerConfirmed,
      requires_provider_disconnect: !providerConfirmed,
      ...(providerConfirmed ? { requires_reconciliation: true } : {}),
      message: providerConfirmed
        ? 'Compte déconnecté chez le fournisseur ; état PURAMA à confirmer.'
        : 'Publication désactivée dans PURAMA ; déconnexion du fournisseur à confirmer.',
    }, 202);
    const success = () => reply({ success: true, local_disconnected: true, provider_disconnected: true });
    const validBinding = async () => {
      const binding = await deps.store.binding(user.id);
      return binding?.user_id === user.id && binding.creation_status === 'ready' &&
        binding.zernio_profile_id === account.zernio_profile_id;
    };
    // Only the first claimant may send DELETE. While that handler is still
    // running, a reader must not release its lock before its external effect.
    if (account.disconnect_pending) {
      if (account.is_active || !account.disconnect_reconcile_ready || !account.publishing_verified_at) return partial();
      try {
        if (!await validBinding()) return partial();
        // Absence is evidence only from a complete, authenticated provider list.
        if (!await deps.confirmAccountAbsent({ profileId: account.zernio_profile_id,
          accountId: account.zernio_account_id })) return partial();
        try { return await deps.store.finishDisconnect(account) ? success() : partial(true); }
        catch { return partial(true); }
      } catch { return partial(); }
    }
    // Stop future PURAMA posts before contacting the provider. The conditional
    // write requires pending=false and compares the complete binding snapshot.
    if (!await deps.store.deactivate(account)) return reply({ error: 'Le compte a changé. Actualise la liste avant de réessayer.' }, 409);
    // This is called only in terminal branches: no later external DELETE may
    // occur after a reader is allowed to reconcile the provider state.
    const uncertain = async (providerConfirmed = false) => {
      try { await deps.store.allowDisconnectReconciliation(account); } catch { /* remains locked */ }
      return partial(providerConfirmed);
    };
    // A brand-new local-only withdrawal can finish before any provider DELETE.
    // Never unlock an earlier uncertain DELETE merely because a later GET fails.
    const releaseBeforeDelete = async () => {
      try { await deps.store.finishDisconnect(account); } catch { /* remains locked */ }
      return partial();
    };
    if (!account.publishing_verified_at) return await releaseBeforeDelete();
    let deleteStarted = false;
    try {
      if (!await validBinding()) return await releaseBeforeDelete();
      await deps.verifyAccount({ profileId: account.zernio_profile_id,
        accountId: account.zernio_account_id, platform: account.platform });
      // Several networks share a profile: never DELETE /profiles here.
      deleteStarted = true;
      await deps.disconnectAccount(account.zernio_account_id);
      try {
        if (!await deps.store.finishDisconnect(account)) return await uncertain(true);
      } catch { return await uncertain(true); }
      return success();
    } catch { return deleteStarted ? await uncertain() : await releaseBeforeDelete(); }
  } catch { return reply({ error: 'Service des comptes sociaux indisponible' }, 503); }
}
export function defaultSocialConfig(userId: string): SocialConfig {
  return { user_id: userId, autopilot_enabled: false, auto_caption: false,
    auto_hashtags: false, default_platforms: [], timezone: 'Europe/Paris' };
}
export async function handleSocialConfigRequest(req: Request, deps: ConfigDeps): Promise<Response> {
  const reply = (body: unknown, status = 200) => json(body, status, deps.corsHeaders);
  if (req.method === 'OPTIONS') return new Response(null, { headers: deps.corsHeaders });
  if (!['GET', 'POST', 'PUT'].includes(req.method)) return reply({ error: 'Method not allowed' }, 405);
  try {
    const user = await identity(req, deps);
    if (!user) return reply({ error: 'Unauthorized' }, 401);
    const existing = await deps.store.read(user.id);
    if (existing && existing.user_id !== user.id) return reply({ error: 'Configuration incohérente' }, 409);
    // No implicit LLM spend, even if legacy defaults still have these flags true.
    const current: SocialConfig = {
      ...(existing ?? defaultSocialConfig(user.id)), auto_caption: false, auto_hashtags: false,
    };
    if (req.method === 'GET') return reply(current);
    let body: Record<string, unknown>;
    try {
      const raw = await req.text();
      if (raw.length > 8192) return reply({ error: 'Requête trop volumineuse' }, 413);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      body = parsed;
    } catch { return reply({ error: 'Configuration JSON invalide' }, 400); }
    const allowed = ['autopilot_enabled', 'auto_caption', 'auto_hashtags', 'default_platforms', 'timezone'];
    if (Object.keys(body).some(key => !allowed.includes(key))) return reply({ error: 'Champ de configuration non autorisé' }, 400);
    for (const field of ['autopilot_enabled', 'auto_caption', 'auto_hashtags']) {
      if (field in body && typeof body[field] !== 'boolean') return reply({ error: 'Valeur booléenne requise' }, 400);
    }
    if (body.auto_caption === true || body.auto_hashtags === true) return reply({ error: 'Prépare la légende et les hashtags avant de publier.' }, 422);
    if ('default_platforms' in body && (!Array.isArray(body.default_platforms) ||
        body.default_platforms.length > deps.platforms.length ||
        body.default_platforms.some(value => typeof value !== 'string' || !deps.platforms.includes(value)))) {
      return reply({ error: 'Liste des plateformes invalide' }, 400);
    }
    if ('timezone' in body) {
      if (typeof body.timezone !== 'string' || body.timezone.length > 100 || !body.timezone) return reply({ error: 'Fuseau horaire invalide' }, 400);
      try { new Intl.DateTimeFormat('fr', { timeZone: body.timezone }).format(); }
      catch { return reply({ error: 'Fuseau horaire invalide' }, 400); }
    }
    const config: SocialConfig = {
      ...current, ...body, user_id: user.id, auto_caption: false, auto_hashtags: false,
      default_platforms: Array.from(new Set((body.default_platforms ?? current.default_platforms) as string[])),
    };
    if (config.autopilot_enabled) {
      if (!config.default_platforms.length) return reply({ error: 'Choisis au moins un compte vérifié.' }, 409);
      if (config.default_platforms.includes('twitter')) return reply({ error: 'Le financement des publications X doit être confirmé avant activation.' }, 409);
      const verified = await deps.store.verifiedPlatforms(user.id);
      if (config.default_platforms.some(platform => !verified.includes(platform))) return reply({ error: 'Reconnecte et vérifie les comptes sélectionnés avant activation.' }, 409);
    }
    return reply(await deps.store.write(config, existing));
  } catch (error) {
    if (error instanceof SocialConfigurationConflict) return reply({ error: 'Les réglages ont changé pendant l’enregistrement. Actualise-les avant de réessayer.' }, 409);
    return reply({ error: 'Configuration sociale indisponible' }, 503);
  }
}
