import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRequestScope, useScopedState } from '@/hooks/useRequestScope';
import {
  requestIaoRoutines, RoutineClientError, type Routine, type RoutineInput, type RoutineList,
  type RoutineRequests, type RoutineResults,
} from '@/lib/iao-routines-client';

interface RoutineState {
  data: RoutineList | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  operationError: string | null;
  uncertain: boolean;
  notice: string | null;
  busy: string | null;
  preview: { fingerprint: string; occurrences: string[] } | null;
  uncertainRuns: string[];
}

const EMPTY: RoutineState = {
  data: null, loading: true, refreshing: false, error: null, operationError: null,
  uncertain: false, notice: null, busy: null, preview: null, uncertainRuns: [],
};

/** Canonical normalized configs are plain data; do not include access tokens in this identity. */
export const routineFingerprint = (config: RoutineInput): string => JSON.stringify(config);

export function useIaoRoutines() {
  const { user, session } = useAuth();
  const ownerId = user?.id && session?.user?.id === user.id ? user.id : null;
  const accessToken = ownerId ? session.access_token : null;
  const key = ownerId ?? 'anonymous';
  const captureRequest = useRequestScope(key);
  const owner = useMemo(() => ({ ownerId, accessToken, current: (): boolean => false, controllers: new Set<AbortController>() }), [ownerId, accessToken]);
  useLayoutEffect(() => {
    owner.current = captureRequest();
    return () => { owner.current = () => false; };
  }, [owner, captureRequest]);
  const captureOwner = useCallback(() => owner.current, [owner]);
  const [state, setState] = useScopedState<RoutineState>(key, EMPTY);
  const readSequence = useRef(0);
  const controllers = owner.controllers;
  const activeMutation = useRef<{ current(): boolean } | null>(null);
  const acceptedPreview = useRef<{ fingerprint: string; expiresAt: number; current(): boolean } | null>(null);
  const attempts = useRef(new Map<string, string>());

  const invoke = useCallback(async <A extends keyof RoutineRequests>(
    action: A, payload: RoutineRequests[A], current: () => boolean,
  ): Promise<RoutineResults[A]> => {
    if (!ownerId || !accessToken || !current()) throw new RoutineClientError('Connectez-vous pour gérer vos routines.');
    const controller = new AbortController();
    controllers.add(controller);
    try {
      return await requestIaoRoutines(action, payload, { ownerId, accessToken, current, signal: controller.signal });
    } finally { controllers.delete(controller); }
  }, [ownerId, accessToken, controllers]);

  const refresh = useCallback(async (): Promise<void> => {
    const current = captureOwner();
    if (!ownerId || !current()) return;
    const sequence = ++readSequence.current;
    setState(previous => ({ ...previous, refreshing: true, error: null }));
    try {
      const data = await invoke('list', {}, current);
      if (!current() || sequence !== readSequence.current) return;
      setState(previous => ({ ...previous, data, loading: false, refreshing: false, error: null }));
    } catch (error) {
      if (!current() || sequence !== readSequence.current) return;
      setState(previous => ({ ...previous, loading: false, refreshing: false,
        error: error instanceof RoutineClientError ? error.message : 'Impossible de charger vos routines.' }));
    }
  }, [captureOwner, invoke, ownerId, setState]);

  useEffect(() => {
    void refresh();
    return () => { for (const controller of controllers) controller.abort(); };
  }, [refresh, controllers]);

  const mutate = useCallback(async <A extends keyof RoutineRequests>(
    action: A, payload: RoutineRequests[A], notice: (result: RoutineResults[A]) => string,
  ): Promise<RoutineResults[A]> => {
    const current = captureOwner();
    if (!current() || !ownerId) throw new RoutineClientError('La session a changé.');
    if (activeMutation.current?.current()) throw new RoutineClientError('Une demande est déjà en cours.');
    const ticket = { current };
    activeMutation.current = ticket;
    setState(previous => ({ ...previous, busy: action, operationError: null, notice: null, uncertain: false }));
    try {
      const result = await invoke(action, payload, current);
      if (!current()) throw new RoutineClientError('La session a changé.');
      setState(previous => ({ ...previous, notice: notice(result) }));
      await refresh();
      if (!current()) throw new RoutineClientError('La session a changé.');
      return result;
    } catch (error) {
      if (current()) setState(previous => ({ ...previous,
        operationError: error instanceof RoutineClientError ? error.message : 'Résultat non confirmé. Actualisez les routines.',
        uncertain: error instanceof RoutineClientError ? error.uncertain : true,
      }));
      throw error;
    } finally {
      if (activeMutation.current === ticket) activeMutation.current = null;
      if (current()) setState(previous => ({ ...previous, busy: null }));
    }
  }, [captureOwner, invoke, ownerId, refresh, setState]);

  const preview = useCallback(async (config: RoutineInput): Promise<string[]> => {
    const current = captureOwner();
    if (!current() || !ownerId) throw new RoutineClientError('La session a changé.');
    if (activeMutation.current?.current()) throw new RoutineClientError('Une demande est déjà en cours.');
    const ticket = { current };
    activeMutation.current = ticket;
    const fingerprint = routineFingerprint(config);
    acceptedPreview.current = null;
    setState(previous => ({ ...previous, busy: 'preview', preview: null, operationError: null, notice: null }));
    try {
      const result = await invoke('preview', { config }, current);
      if (!current()) throw new RoutineClientError('La session a changé.');
      acceptedPreview.current = { fingerprint, expiresAt: Date.now() + 5 * 60_000, current };
      setState(previous => ({ ...previous, preview: { fingerprint, occurrences: result.occurrences } }));
      return result.occurrences;
    } catch (error) {
      if (current()) setState(previous => ({ ...previous, operationError: error instanceof RoutineClientError
        ? error.message : 'Impossible de vérifier les prochaines occurrences.' }));
      throw error;
    } finally {
      if (activeMutation.current === ticket) activeMutation.current = null;
      if (current()) setState(previous => ({ ...previous, busy: null }));
    }
  }, [captureOwner, invoke, ownerId, setState]);

  const save = useCallback(async (id: string, expectedRevision: number, config: RoutineInput): Promise<Routine> => {
    const receipt = acceptedPreview.current;
    if (config.enabled && (!receipt || !receipt.current() || receipt.expiresAt <= Date.now()
      || receipt.fingerprint !== routineFingerprint(config))) {
      const error = new RoutineClientError('Vérifiez les prochaines occurrences avant d’activer ces réglages.');
      setState(previous => ({ ...previous, operationError: error.message }));
      throw error;
    }
    const result = await mutate('save', { id, expectedRevision, config }, () => config.enabled
      ? 'Routine enregistrée et activée.' : 'Routine enregistrée en pause.');
    acceptedPreview.current = null;
    return result.routine;
  }, [mutate, setState]);

  const pause = useCallback((routine: Routine) => mutate('pause', {
    id: routine.id, expectedRevision: routine.revision, pausedUntil: null, enabled: false,
  }, () => 'Routine mise en pause. Les envois en attente seront arrêtés ; un appel déjà transmis peut continuer.'), [mutate]);

  const pauseAll = useCallback(() => mutate('pause-all', {}, result => result.updatedCount > 0
    ? `${result.updatedCount} routine${result.updatedCount > 1 ? 's' : ''} mise${result.updatedCount > 1 ? 's' : ''} en pause. Un appel déjà transmis peut continuer.`
    : 'Toutes vos routines sont déjà en pause.'), [mutate]);

  const runNow = useCallback(async (routine: Routine) => {
    const current = captureOwner();
    if (!current() || !ownerId) throw new RoutineClientError('La session a changé.');
    const attemptKey = `${ownerId}:${routine.id}:${routine.revision}`;
    const requestId = attempts.current.get(attemptKey) ?? crypto.randomUUID();
    attempts.current.set(attemptKey, requestId);
    try {
      const result = await mutate('run-now', { id: routine.id, expectedRevision: routine.revision, requestId }, () =>
        'Demande enregistrée. Consultez son état ci-dessous ; une mise en attente ne confirme pas la réception.');
      if (current()) {
        attempts.current.delete(attemptKey);
        setState(previous => ({ ...previous, uncertainRuns: previous.uncertainRuns.filter(id => id !== routine.id) }));
      }
      return result.occurrence;
    } catch (error) {
      if (current() && error instanceof RoutineClientError && error.uncertain) {
        setState(previous => ({ ...previous, uncertainRuns: [...new Set([...previous.uncertainRuns, routine.id])] }));
      } else if (current()) attempts.current.delete(attemptKey);
      throw error;
    }
  }, [captureOwner, mutate, ownerId, setState]);

  const cancel = useCallback((occurrenceId: string) => mutate('cancel', { occurrenceId }, result => result.warning), [mutate]);
  const clearFeedback = useCallback(() => {
    if (captureOwner()()) setState(previous => ({ ...previous,
      operationError: null, notice: null, preview: null, uncertain: false,
    }));
  }, [captureOwner, setState]);

  return { ...state, ownerId, refresh, preview, save, pause, pauseAll, runNow, cancel, clearFeedback,
    previewResult: state.preview };
}
