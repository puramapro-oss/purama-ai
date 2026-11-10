export async function openAuthSessionAsync(_url: string, _redirectUrl: string): Promise<{ type: "success"; url: string } | { type: "cancel" }> {
  return { type: "cancel" as const };
}
