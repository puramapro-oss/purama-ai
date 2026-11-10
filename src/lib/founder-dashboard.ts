export type DashboardMetric =
  | { status: 'available'; value: number }
  | { status: 'unavailable'; value: null };

export interface FounderDashboardSnapshot {
  version: 1;
  scope: 'purama_ai';
  observedAt: string;
  metrics: {
    profiles: DashboardMetric;
    activeSubscriptions: DashboardMetric;
    enabledAgents: DashboardMetric;
  };
  recentProfiles: {
    status: 'available' | 'unavailable';
    items: Array<{ id: string; full_name: string | null; created_at: string | null }>;
  };
}

type RecordValue = Record<string, unknown>;
const INVALID_RESPONSE = 'Les données reçues ne sont pas vérifiables. Réessayez dans un instant.';

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID_RESPONSE);
  return value as RecordValue;
}

function metric(value: unknown): DashboardMetric {
  const entry = record(value);
  if (entry.status === 'unavailable' && entry.value === null) return { status: 'unavailable', value: null };
  if (entry.status === 'available' && Number.isSafeInteger(entry.value) && (entry.value as number) >= 0) {
    return { status: 'available', value: entry.value as number };
  }
  throw new Error(INVALID_RESPONSE);
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

/** Validate and project the response; never render arbitrary provider payloads. */
export function decodeFounderDashboard(value: unknown): FounderDashboardSnapshot {
  const data = record(value);
  if (data.version !== 1 || data.scope !== 'purama_ai' || !timestamp(data.observedAt)) throw new Error(INVALID_RESPONSE);
  const metrics = record(data.metrics);
  const recent = record(data.recentProfiles);
  if (!['available', 'unavailable'].includes(String(recent.status)) || !Array.isArray(recent.items) || recent.items.length > 10) {
    throw new Error(INVALID_RESPONSE);
  }
  if (recent.status === 'unavailable' && recent.items.length !== 0) throw new Error(INVALID_RESPONSE);
  const seen = new Set<string>();
  const items = recent.items.map((value) => {
    const item = record(value);
    if (typeof item.id !== 'string' || !item.id || item.id.length > 100 || seen.has(item.id)) throw new Error(INVALID_RESPONSE);
    if (item.full_name !== null && (typeof item.full_name !== 'string' || item.full_name.length > 500)) throw new Error(INVALID_RESPONSE);
    if (item.created_at !== null && !timestamp(item.created_at)) throw new Error(INVALID_RESPONSE);
    seen.add(item.id);
    return { id: item.id, full_name: item.full_name as string | null, created_at: item.created_at as string | null };
  });
  return {
    version: 1,
    scope: 'purama_ai',
    observedAt: data.observedAt,
    metrics: {
      profiles: metric(metrics.profiles),
      activeSubscriptions: metric(metrics.activeSubscriptions),
      enabledAgents: metric(metrics.enabledAgents),
    },
    recentProfiles: { status: recent.status as 'available' | 'unavailable', items },
  };
}

type Invoke = (options: { method: 'GET'; signal: AbortSignal; timeout: number }) =>
  Promise<{ data: unknown; error: unknown }>;

function failureMessage(error: unknown): string {
  const context = error && typeof error === 'object' && 'context' in error ? error.context : null;
  const status = context && typeof context === 'object' && 'status' in context ? context.status : null;
  if (status === 401) return 'Votre session doit être renouvelée. Reconnectez-vous pour consulter cet espace.';
  if (status === 403) return 'Le serveur a refusé l’accès à cet espace privé.';
  if (status === 429) return 'Trop d’actualisations rapprochées. Réessayez dans une minute.';
  if (status === 503) return 'La connexion sécurisée du tableau de bord n’est pas encore disponible.';
  return 'Le tableau de bord ne répond pas. Vos données ne sont pas affichées ; vous pouvez réessayer.';
}

export async function loadFounderDashboard(invoke: Invoke, signal: AbortSignal): Promise<FounderDashboardSnapshot> {
  if (signal.aborted) throw new DOMException('Lecture annulée', 'AbortError');
  let result: Awaited<ReturnType<Invoke>>;
  try {
    result = await invoke({ method: 'GET', signal, timeout: 10000 });
  } catch {
    if (signal.aborted) throw new DOMException('Lecture annulée', 'AbortError');
    throw new Error(failureMessage(null));
  }
  if (signal.aborted) throw new DOMException('Lecture annulée', 'AbortError');
  if (result.error) throw new Error(failureMessage(result.error));
  return decodeFounderDashboard(result.data);
}

export function dashboardMetricLabel(value: DashboardMetric | undefined): string {
  return value?.status === 'available' ? value.value.toLocaleString('fr-FR') : '—';
}
