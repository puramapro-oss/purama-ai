type Customer = { id: string; metadata: Record<string, string>; deleted?: false };
type DeletedCustomer = { id: string; deleted: true };
type SubscriptionRow = { user_id: string; plan_type: string; status: string; stripe_customer_id: string | null };
type QueryResult<T> = { data: T; error: { message: string } | null };

export const fixture: {
  customers: Customer[];
  retrievedCustomer: Customer | DeletedCustomer;
  subscriptions: Record<string, unknown>[];
  calls: { status: string; limit: number; customer: string }[];
  customersHasMore: boolean;
  subscriptionsHasMore: Record<string, boolean>;
  rows: SubscriptionRow[];
  rowError: boolean;
  bindingError: boolean;
  authUser: { id: string; email: string } | null;
  authError: boolean;
  authCalls: string[];
  clientsCreated: number;
  customerLists: { email: string; limit: number }[];
  customerRetrievals: string[];
  customerCreations: unknown[];
  databaseReads: { column: string; value: unknown }[];
  customerError: string | null;
  subscriptionError: string | null;
} = {} as typeof fixture;

export function resetFixture(): void {
  fixture.customers = [{ id: 'cus_fixture', metadata: { user_id: 'fixture-user' } }];
  fixture.retrievedCustomer = { id: 'cus_fixture', metadata: { user_id: 'fixture-user' } };
  fixture.subscriptions = [];
  fixture.calls = [];
  fixture.customersHasMore = false;
  fixture.subscriptionsHasMore = {};
  fixture.rows = [];
  fixture.rowError = false;
  fixture.bindingError = false;
  fixture.authUser = { id: 'fixture-user', email: 'fixture@example.invalid' };
  fixture.authError = false;
  fixture.authCalls = [];
  fixture.clientsCreated = 0;
  fixture.customerLists = [];
  fixture.customerRetrievals = [];
  fixture.customerCreations = [];
  fixture.databaseReads = [];
  fixture.customerError = null;
  fixture.subscriptionError = null;
}
resetFixture();

export function createClient(..._args: unknown[]) {
  fixture.clientsCreated++;
  return {
    auth: { getUser: (token: string): Promise<QueryResult<{ user: typeof fixture.authUser }>> => {
      fixture.authCalls.push(token);
      return Promise.resolve({ data: { user: fixture.authUser }, error: fixture.authError ? { message: 'private authentication detail' } : null });
    } },
    from(table: string) {
      if (table !== 'subscriptions') throw new Error('Unexpected fixture table');
      let column: keyof SubscriptionRow;
      let value: unknown;
      const query = {
        select(_columns: string) { return query; },
        eq(key: keyof SubscriptionRow, expected: unknown) { column = key; value = expected; return query; },
        maybeSingle(): Promise<QueryResult<SubscriptionRow | null>> {
          fixture.databaseReads.push({ column, value });
          const rows = fixture.rows.filter(row => row[column] === value);
          return Promise.resolve({
            data: rows.length === 1 ? structuredClone(rows[0]) : null,
            error: fixture.rowError || rows.length > 1 ? { message: 'private database row detail' } : null,
          });
        },
        limit(count: number): Promise<QueryResult<{ user_id: string }[] | null>> {
          fixture.databaseReads.push({ column, value });
          return Promise.resolve({
            data: fixture.rows.filter(row => row[column] === value).slice(0, count).map(row => ({ user_id: row.user_id })),
            error: fixture.bindingError ? { message: 'private database binding detail' } : null,
          });
        },
      };
      return query;
    },
  };
}

class Stripe {
  constructor(_key: string, _options: unknown) {}
  static createFetchHttpClient(_fetch?: typeof fetch): null { return null; }
  customers = {
    list: (options: { limit: number; email: string }) => {
      fixture.customerLists.push(structuredClone(options));
      if (fixture.customerError) throw new Error(fixture.customerError);
      return Promise.resolve({ data: structuredClone(fixture.customers.slice(0, options.limit)), has_more: fixture.customersHasMore });
    },
    retrieve: (id: string) => {
      fixture.customerRetrievals.push(id);
      if (fixture.customerError) throw new Error(fixture.customerError);
      return Promise.resolve(structuredClone(fixture.retrievedCustomer));
    },
    create: (parameters: unknown, _options: unknown): Promise<Customer> => {
      fixture.customerCreations.push(parameters);
      return Promise.reject(new Error('Read-only subscription lookup must not create a customer'));
    },
  };
  subscriptions = { list: (options: { status: string; limit: number; customer: string }) => {
    fixture.calls.push(structuredClone(options));
    if (fixture.subscriptionError) throw new Error(fixture.subscriptionError);
    return Promise.resolve({ data: structuredClone(fixture.subscriptions.filter(value => value.status === options.status).slice(0, options.limit)),
      has_more: fixture.subscriptionsHasMore[options.status] ?? false });
  } };
}
// Mirror only the qualifiers used by the existing billing boundary.
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Stripe {
  export type Customer = CustomerShape;
  export type DeletedCustomer = DeletedCustomerShape;
}
type CustomerShape = Customer;
type DeletedCustomerShape = DeletedCustomer;
export default Stripe;
