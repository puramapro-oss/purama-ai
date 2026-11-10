// These fixtures also reproduce the pre-fix handler. No real provider is contacted.
export const effects: { clients: number; writes: unknown[]; emails: unknown[] } = {
  clients: 0, writes: [], emails: [],
};
export function resetEffects(): void {
  effects.clients = 0;
  effects.writes.length = 0;
  effects.emails.length = 0;
}
type Result = { data: unknown; error: null };
class Query {
  private mutation = false;
  constructor(private table: string) {}
  select(_columns: string): this { return this; }
  gte(_field: string, _value: unknown): this { return this; }
  lt(_field: string, _value: unknown): this { return this; }
  eq(_field: string, _value: unknown): this { return this; }
  in(_field: string, _value: unknown): this { return this; }
  update(value: unknown): this {
    this.mutation = true; effects.writes.push({ table: this.table, value }); return this;
  }
  insert(value: unknown): this {
    this.mutation = true; effects.writes.push({ table: this.table, value }); return this;
  }
  single(): Promise<Result> {
    return Promise.resolve({ data: { email: 'fixture@example.invalid' }, error: null });
  }
  then(resolve: (result: Result) => unknown, reject?: (error: unknown) => unknown): Promise<unknown> {
    const data = this.mutation ? null : this.table === 'influencers'
      ? [{ id: 'fixture-influencer', user_id: 'fixture-user', beneficiary_name: 'Fixture', iban: 'FR_FIXTURE_ONLY_0000' }]
      : [{ id: 'fixture-commission', commission_amount: 75 }];
    return Promise.resolve({ data, error: null }).then(resolve, reject);
  }
}
export function createClient(..._args: unknown[]): { from: (table: string) => Query } {
  effects.clients++;
  return { from: (table: string) => new Query(table) };
}
export class Resend {
  constructor(_key: string) {}
  emails = { send: (value: unknown) => { effects.emails.push(value); return Promise.resolve({}); } };
}
