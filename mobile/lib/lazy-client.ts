/**
 * Keep route-module evaluation free of client construction. The first real
 * property access constructs one client. Methods retain their native receiver
 * and stable identity; a failed construction is never cached as an instance.
 */
export function createLazyClient<T extends object>(factory: () => T): T {
  let instance: T | undefined;
  const methods = new Map<PropertyKey, { original: unknown; bound: unknown }>();
  const getInstance = (): T => instance ??= factory();

  return new Proxy({} as T, {
    get(_target, key) {
      const client = getInstance();
      const value: unknown = Reflect.get(client, key, client);
      if (typeof value !== "function") return value;
      const cached = methods.get(key);
      if (cached?.original === value) return cached.bound;
      const bound = value.bind(client);
      methods.set(key, { original: value, bound });
      return bound;
    },
    set(_target, key, value) {
      const client = getInstance();
      methods.delete(key);
      return Reflect.set(client, key, value, client);
    },
    has(_target, key) { return Reflect.has(getInstance(), key); },
    ownKeys() { return Reflect.ownKeys(getInstance()); },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(getInstance(), key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf() { return Reflect.getPrototypeOf(getInstance()); },
  });
}
