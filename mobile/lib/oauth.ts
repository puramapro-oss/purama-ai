import { supabase } from "@/lib/supabase";

const MAX_AUTH_CODE_LENGTH = 4096;

export async function exchangeOAuthCode(code: string): Promise<void> {
  if (!code || code.length > MAX_AUTH_CODE_LENGTH) {
    throw new Error("Invalid OAuth callback");
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) throw new Error(error.message);
}

export async function completeOAuthRedirect(url: string, expectedRedirectUrl: string): Promise<void> {
  const callback = new URL(url);
  const expected = new URL(expectedRedirectUrl);
  if (callback.protocol !== expected.protocol || callback.host !== expected.host || callback.pathname !== expected.pathname) {
    throw new Error("OAuth callback URL did not match the expected redirect");
  }
  const providerError = callback.searchParams.get("error_description") ?? callback.searchParams.get("error");
  if (providerError) throw new Error(providerError);

  const code = callback.searchParams.get("code");
  if (!code) throw new Error("OAuth callback did not contain an authorization code");
  await exchangeOAuthCode(code);
}
