export const fixture: {
  customers: { id: string }[];
  subscriptions: Record<string, unknown>[];
  calls: { status: string; limit: number }[];
  customersHasMore: boolean;
  subscriptionsHasMore: Record<string, boolean>;
} = { customers: [{ id: 'cus_fixture' }], subscriptions: [], calls: [], customersHasMore: false, subscriptionsHasMore: {} };

export function createClient(..._args: unknown[]) {
  return { auth: { getUser: (_token: string): Promise<{
    data: { user: { id: string; email: string } }; error: { message: string } | null;
  }> => Promise.resolve({ data: { user: { id: 'fixture-user', email: 'fixture@example.invalid' } }, error: null }) } };
}
export default class Stripe {
  constructor(_key: string, _options: unknown) {}
  static createFetchHttpClient(): null { return null; }
  customers = { list: (options: { limit: number; email: string }) => Promise.resolve({
    data: fixture.customers.slice(0, options.limit), has_more: fixture.customersHasMore,
  }) };
  subscriptions = { list: (options: { status: string; limit: number; customer: string }) => {
    fixture.calls.push({ status: options.status, limit: options.limit });
    return Promise.resolve({ data: fixture.subscriptions.filter(value => value.status === options.status).slice(0, options.limit),
      has_more: fixture.subscriptionsHasMore[options.status] ?? false });
  } };
}
