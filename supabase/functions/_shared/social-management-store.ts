import type {
  AccountStore, ConfigStore, ManagedSocialAccount, SocialConfig, SocialProfileBinding,
} from './social-management-core.ts';
import { SocialConfigurationConflict } from './social-management-core.ts';
import type { SocialDbClient, SocialDbResult } from './social-publish-store.ts';
// Runtime-selected schemas share the same PostgREST protocol. Adapt the SDK
// boundary once; authentication and policy logic keep their domain interfaces.
export interface ManagementDb { from(table: string): unknown }
function read<T>(result: SocialDbResult): T {
  if (result.error) throw new Error('Social database unavailable');
  return result.data as T;
}
export function createAccountStore(db: ManagementDb): AccountStore {
  const queryDb = db as SocialDbClient;
  return {
    async list(userId) {
      return read<ManagedSocialAccount[] | null>(await queryDb.from('social_accounts')
        .select('*').eq('user_id', userId).order('connected_at', { ascending: false })) ?? [];
    },
    async find(userId, platform) {
      return read<ManagedSocialAccount | null>(await queryDb.from('social_accounts')
        .select('*').eq('user_id', userId).eq('platform', platform).maybeSingle());
    },
    async binding(userId) {
      return read<SocialProfileBinding | null>(await queryDb.from('social_profile_bindings')
        .select('user_id,zernio_profile_id,creation_status').eq('user_id', userId).maybeSingle());
    },
    async deactivate(account) {
      let query = queryDb.from('social_accounts').update({ is_active: false, disconnect_pending: true, disconnect_reconcile_ready: false })
        .eq('id', account.id).eq('user_id', account.user_id).eq('platform', account.platform)
        .eq('zernio_account_id', account.zernio_account_id).eq('zernio_profile_id', account.zernio_profile_id)
        .eq('disconnect_pending', false);
      query = account.publishing_verified_at
        ? query.eq('publishing_verified_at', account.publishing_verified_at)
        : query.is('publishing_verified_at', null);
      const rows = read<{ id: string }[] | null>(await query.select('id'));
      return rows?.length === 1 && rows[0].id === account.id;
    },
    async allowDisconnectReconciliation(account) {
      let query = queryDb.from('social_accounts').update({ disconnect_reconcile_ready: true })
        .eq('id', account.id).eq('user_id', account.user_id).eq('platform', account.platform)
        .eq('zernio_account_id', account.zernio_account_id).eq('zernio_profile_id', account.zernio_profile_id)
        .eq('is_active', false).eq('disconnect_pending', true).eq('disconnect_reconcile_ready', false);
      query = account.publishing_verified_at
        ? query.eq('publishing_verified_at', account.publishing_verified_at)
        : query.is('publishing_verified_at', null);
      const rows = read<{ id: string }[] | null>(await query.select('id'));
      return rows?.length === 1 && rows[0].id === account.id;
    },
    async finishDisconnect(account) {
      // The migration stamps disconnect_completed_at with the database clock.
      let query = queryDb.from('social_accounts').update({ disconnect_pending: false, disconnect_reconcile_ready: false })
        .eq('id', account.id).eq('user_id', account.user_id).eq('platform', account.platform)
        .eq('zernio_account_id', account.zernio_account_id).eq('zernio_profile_id', account.zernio_profile_id)
        .eq('is_active', false).eq('disconnect_pending', true);
      query = account.publishing_verified_at
        ? query.eq('publishing_verified_at', account.publishing_verified_at)
        : query.is('publishing_verified_at', null);
      const rows = read<{ id: string }[] | null>(await query.select('id'));
      return rows?.length === 1 && rows[0].id === account.id;
    },
  };
}
export function createConfigStore(db: ManagementDb): ConfigStore {
  const queryDb = db as SocialDbClient;
  const fields = 'user_id,autopilot_enabled,auto_caption,auto_hashtags,default_platforms,timezone,updated_at';
  return {
    async read(userId) {
      return read<SocialConfig | null>(await queryDb.from('social_autopilot_config')
        .select(fields)
        .eq('user_id', userId).maybeSingle());
    },
    async write(config, previous) {
      const values = { user_id: config.user_id, autopilot_enabled: config.autopilot_enabled,
        auto_caption: config.auto_caption, auto_hashtags: config.auto_hashtags,
        default_platforms: config.default_platforms, timezone: config.timezone };
      let query;
      if (previous) {
        query = queryDb.from('social_autopilot_config').update(values).eq('user_id', config.user_id);
        query = previous.updated_at == null ? query.is('updated_at', null) : query.eq('updated_at', previous.updated_at);
      } else {
        query = queryDb.from('social_autopilot_config').insert(values);
      }
      const result = await query.select(fields).maybeSingle();
      if (!previous && result.error?.code === '23505') throw new SocialConfigurationConflict('Concurrent configuration creation');
      const saved = read<SocialConfig | null>(result);
      if (!saved) throw new SocialConfigurationConflict('Concurrent configuration update');
      if (saved.user_id !== config.user_id) throw new Error('Configuration write not confirmed');
      return saved;
    },
    async verifiedPlatforms(userId) {
      const rows = read<{ platform: string; publishing_verified_at: string | null }[] | null>(
        await queryDb.from('social_accounts').select('platform,publishing_verified_at')
          .eq('user_id', userId).eq('is_active', true));
      return (rows ?? []).filter(row => row.publishing_verified_at).map(row => row.platform);
    },
  };
}
