export function useCustomAgentKartaState() { return { data: null, isError: false }; }
export function useCustomAgentKartaRuns() { return { data: [] }; }
export function useCustomAgentPendingActions() { return { data: [] }; }
export function useUpdateCustomAgentKartaState() { return { mutateAsync: async () => { throw new Error('No KARTA mutation authorized'); }, isPending: false }; }
export function useTriggerCustomAgent() { return { mutateAsync: async () => { throw new Error('No KARTA trigger authorized'); }, isPending: false }; }
