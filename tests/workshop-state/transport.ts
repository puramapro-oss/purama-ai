/** Only this test configuration replaces the transport; production uses the authenticated Supabase client. */
export const supabase = { functions: { async invoke(_name: string, { body, signal }: { body: unknown; signal?: AbortSignal }) {
  const response = await fetch('/__workshop-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.ok) return { data: null, error: { context: response } };
  return { data: await response.json(), error: null };
} } };
