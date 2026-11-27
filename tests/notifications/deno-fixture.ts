import { createFixture } from './fixtures.mjs';

let current = createFixture();
export function reset(options = {}) { current = createFixture(options); return current; }
export function getFixture() { return current; }
export function createClient(...args: unknown[]) { return current.createClient(...args); }
export class Resend {
  private readonly provider: InstanceType<ReturnType<typeof createFixture>['Resend']>;
  constructor(key: string) { this.provider = new current.Resend(key); }
  get emails() { return this.provider.emails; }
}
