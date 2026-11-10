// Inject the hook infrastructure only. The real admin hook supplies its mutation
// implementation; any attempted database operation is observable and forbidden.
export const adminFixture = {
  databaseCalls: 0,
  successMessages: [] as string[],
  errorMessages: [] as Array<{ title: string; description?: string }>,
  invalidations: 0,
};

interface QueryResult { data: null; error: null }
class ForbiddenQuery implements PromiseLike<QueryResult> {
  select(_fields?: string) { return this; }
  insert(_values: unknown) { return this; }
  update(_values: unknown) { return this; }
  eq(_field: string, _value: unknown) { return this; }
  order(_field: string, _options: unknown) { return this; }
  single() { return Promise.resolve({ data: null, error: null }); }
  maybeSingle() { return this.single(); }
  then<T = QueryResult, U = never>(
    fulfilled?: ((value: QueryResult) => T | PromiseLike<T>) | null,
    rejected?: ((reason: unknown) => U | PromiseLike<U>) | null,
  ): PromiseLike<T | U> {
    return Promise.resolve({ data: null, error: null }).then(fulfilled, rejected);
  }
}
export const supabase = {
  from(_table: string): ForbiddenQuery {
    adminFixture.databaseCalls++;
    throw new Error("Administrative payment must not access the database");
  },
  async rpc(_name: string, _params: unknown): Promise<{ data: string; error: null }> {
    adminFixture.databaseCalls++;
    throw new Error("Administrative payment must not call an RPC");
  },
};
export function useQuery<T>(_options: {
  queryKey: unknown[]; queryFn: () => Promise<T>; enabled?: boolean;
}) {
  // Query hydration is outside this test: do not execute read-only queryFns.
  return { data: undefined as T | undefined, isLoading: false };
}
export function useQueryClient() {
  return { invalidateQueries(_options: unknown) { adminFixture.invalidations++; } };
}
export function useMutation<T, V>(options: {
  mutationFn: (value: V) => Promise<T>;
  onSuccess?: (value: T) => void;
  onError?: (error: Error) => void;
}) {
  return {
    async mutateAsync(value: V) {
      try {
        const result = await options.mutationFn(value);
        options.onSuccess?.(result);
        return result;
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
  };
}
export function useAuth() { return { user: { id: "user_test" } }; }
export const toast = {
  success(message: string) { adminFixture.successMessages.push(message); },
  error(title: string, options?: { description?: string }) {
    adminFixture.errorMessages.push({ title, description: options?.description });
  },
};
