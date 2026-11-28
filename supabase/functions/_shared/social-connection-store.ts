import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";
import { SocialConnectionError, type SocialConnectionIntent, type SocialConnectionStore,
  type SocialProfileBinding } from "./social-connection-core.ts";
import { isOAuthSocialPlatform, isSocialUserId, isZernioId } from "./social-state.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SocialConnectionError("social_storage_invalid", 503);
  return value as Record<string, unknown>;
}

export function createSocialConnectionStore(client: Pick<SupabaseClient, "rpc" | "from">): SocialConnectionStore {
  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new SocialConnectionError("social_storage_unavailable", 503);
    return data;
  }
  return {
    async getOrCreateProfile(userId) {
      const row = record(await rpc("social_get_or_create_profile_binding", { p_user_id: userId }));
      if (!isSocialUserId(row.id) || row.user_id !== userId ||
        typeof row.external_id !== "string" || typeof row.profile_name !== "string" ||
        !["pending", "creating", "uncertain", "ready"].includes(String(row.creation_status)) ||
        (row.zernio_profile_id !== null && !isZernioId(row.zernio_profile_id))) {
        throw new SocialConnectionError("profile_binding_invalid", 503);
      }
      return {
        id: row.id, userId, profileId: row.zernio_profile_id as string | null,
        externalId: row.external_id, profileName: row.profile_name,
        creationStatus: row.creation_status as SocialProfileBinding["creationStatus"],
      };
    },
    async claimProfileCreation(bindingId) {
      const result = await rpc("social_claim_profile_creation", { p_binding_id: bindingId });
      if (typeof result !== "boolean") throw new SocialConnectionError("social_storage_invalid", 503);
      return result;
    },
    async recordProfileFailure(bindingId, uncertain) {
      const { error } = await client.from("social_profile_bindings")
        .update({ creation_status: uncertain ? "uncertain" : "pending", updated_at: new Date().toISOString() })
        .eq("id", bindingId).eq("creation_status", "creating");
      if (error) throw new SocialConnectionError("social_storage_unavailable", 503);
    },
    async finishProfile(bindingId, profileId) {
      await rpc("social_finish_profile_binding", { p_binding_id: bindingId, p_profile_id: profileId });
    },
    async beginIntent(intent) {
      await rpc("social_begin_connection", {
        p_user_id: intent.userId, p_platform: intent.platform, p_profile_id: intent.profileId,
        p_state_hash: intent.stateHash, p_nonce: intent.nonce,
        p_issued_at: new Date(intent.issuedAt * 1000).toISOString(),
        p_expires_at: new Date(intent.expiresAt * 1000).toISOString(),
      });
    },
    async readIntent(stateHash) {
      const { data, error } = await client.from("social_connection_intents")
        .select("state_hash,user_id,platform,zernio_profile_id,nonce,issued_at,expires_at,status,zernio_account_id")
        .eq("state_hash", stateHash).maybeSingle();
      if (error) throw new SocialConnectionError("social_storage_unavailable", 503);
      if (!data) return null;
      const row = record(data);
      if (row.state_hash !== stateHash || !isSocialUserId(row.user_id) || !isSocialUserId(row.nonce) ||
        !isOAuthSocialPlatform(row.platform) || !isZernioId(row.zernio_profile_id) ||
        !["pending", "bound", "cancelled", "superseded"].includes(String(row.status)) ||
        (row.zernio_account_id !== null && !isZernioId(row.zernio_account_id))) {
        throw new SocialConnectionError("social_storage_invalid", 503);
      }
      const issuedAt = Date.parse(String(row.issued_at)) / 1000;
      const expiresAt = Date.parse(String(row.expires_at)) / 1000;
      if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) throw new SocialConnectionError("social_storage_invalid", 503);
      return {
        stateHash, userId: row.user_id, platform: row.platform, profileId: row.zernio_profile_id,
        nonce: row.nonce, issuedAt, expiresAt,
        status: row.status as SocialConnectionIntent["status"], accountId: row.zernio_account_id as string | null,
      };
    },
    async cancelIntent(stateHash) {
      const { data, error } = await client.from("social_connection_intents")
        .update({ status: "cancelled", consumed_at: new Date().toISOString() })
        .eq("state_hash", stateHash).eq("status", "pending").select("state_hash").maybeSingle();
      if (error) throw new SocialConnectionError("social_storage_unavailable", 503);
      return data?.state_hash === stateHash;
    },
    async finishIntent(intent, account) {
      const result = record(await rpc("social_finish_connection", {
        p_state_hash: intent.stateHash, p_user_id: intent.userId, p_platform: intent.platform,
        p_profile_id: intent.profileId, p_account_id: account.accountId,
        p_account_name: account.accountName, p_account_username: account.accountUsername,
      }));
      if (result.status !== "bound" && result.status !== "already_processed") throw new SocialConnectionError("social_storage_invalid", 503);
      return result.status;
    },
  };
}
