import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MutateOptions, UseMutationResult } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { useRequestScope } from '@/hooks/useRequestScope';
import { resolveNotificationActionUrl } from '../../supabase/functions/_shared/notification-action-url';

export type NotificationType = 'task_completed' | 'question' | 'daily_report' | 'alert';

export interface Notification {
  id: string;
  user_id: string;
  agent_slug: string | null;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  action_url: string | null;
  created_at: string;
}

export interface NotificationPreferences {
  id: string;
  user_id: string;
  email_enabled: boolean;
  task_completed_enabled: boolean;
  question_enabled: boolean;
  daily_report_enabled: boolean;
  alert_enabled: boolean;
  created_at: string;
  updated_at: string;
}

const preferenceKeys = [
  'email_enabled', 'task_completed_enabled', 'question_enabled',
  'daily_report_enabled', 'alert_enabled',
] as const;
type PreferenceKey = typeof preferenceKeys[number];
export type NotificationPreferencePatch = Partial<Pick<NotificationPreferences, PreferenceKey>>;

type MutationOwner = { ownerId: string; current: () => boolean; confirmedCount?: number };
type OwnedMutation<T> = MutationOwner & { value: T };

/** Bind retained event callbacks to their committed account lifetime, including A→B→A. */
function useNotificationOwner(ownerId: string | undefined) {
  const captureRequest = useRequestScope(ownerId ?? '');
  const lifetime = useMemo<MutationOwner>(() => ({ ownerId: ownerId ?? '', current: () => false }), [ownerId]);
  useLayoutEffect(() => {
    lifetime.current = captureRequest();
    return () => { lifetime.current = () => false; };
  }, [captureRequest, lifetime]);
  return {
    captureRequest,
    input<T>(value: T): OwnedMutation<T> {
      return { value, ownerId: lifetime.ownerId, current: lifetime.current };
    },
  };
}

function bindNotificationMutation<T>(
  mutation: UseMutationResult<MutationOwner, Error, OwnedMutation<T>>,
  input: (value: T) => OwnedMutation<T>,
) {
  const optionsFor = (options?: MutateOptions<MutationOwner, Error, T>): MutateOptions<MutationOwner, Error, OwnedMutation<T>> | undefined => options ? {
    onSuccess: (data, request, context) => { if (request.current()) options.onSuccess?.(data, request.value, context); },
    onError: (error, request, context) => { if (request.current()) options.onError?.(error, request.value, context); },
    onSettled: (data, error, request, context) => { if (request.current()) options.onSettled?.(data, error, request.value, context); },
  } : undefined;
  return {
    ...mutation,
    variables: mutation.variables?.value,
    mutate: (value: T, options?: MutateOptions<MutationOwner, Error, T>) => mutation.mutate(input(value), optionsFor(options)),
    mutateAsync: (value: T, options?: MutateOptions<MutationOwner, Error, T>) => mutation.mutateAsync(input(value), optionsFor(options)),
  };
}

/** Realtime and stored rows share the same owner and navigation boundary. */
function ownedNotification(value: unknown, ownerId: string): Notification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.user_id !== ownerId || typeof row.id !== 'string' || !row.id ||
      typeof row.title !== 'string' || typeof row.message !== 'string' ||
      !['task_completed', 'question', 'daily_report', 'alert'].includes(String(row.type)) ||
      typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at)) ||
      (row.read !== null && typeof row.read !== 'boolean')) return null;
  return {
    id: row.id, user_id: ownerId, type: row.type as NotificationType,
    title: row.title, message: row.message, read: row.read === true,
    agent_slug: typeof row.agent_slug === 'string' ? row.agent_slug : null,
    action_url: resolveNotificationActionUrl(row.action_url), created_at: row.created_at,
  };
}

function ownedPreferences(value: unknown, ownerId: string): NotificationPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Préférences indisponibles');
  const row = value as Record<string, unknown>;
  if (row.user_id !== ownerId || typeof row.id !== 'string' ||
      preferenceKeys.some(key => row[key] !== null && typeof row[key] !== 'boolean')) {
    throw new Error('Préférences indisponibles');
  }
  return {
    id: row.id, user_id: ownerId,
    email_enabled: row.email_enabled !== false,
    task_completed_enabled: row.task_completed_enabled !== false,
    question_enabled: row.question_enabled !== false,
    daily_report_enabled: row.daily_report_enabled !== false,
    alert_enabled: row.alert_enabled !== false,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
  };
}

function preferencePatch(value: NotificationPreferencePatch): NotificationPreferencePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Préférences invalides');
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !preferenceKeys.includes(key as PreferenceKey) ||
      typeof value[key as PreferenceKey] !== 'boolean')) throw new Error('Préférences invalides');
  return Object.fromEntries(keys.map(key => [key, value[key as PreferenceKey]]));
}

export function useNotifications() {
  const { user } = useAuth();
  const ownerId = user?.id;
  const queryClient = useQueryClient();
  const { captureRequest, input } = useNotificationOwner(ownerId);
  const channelId = useId();
  const channelLifetime = useRef(0);

  // Fetch notifications
  const { data: rows = [], isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['notifications', ownerId],
    queryFn: async () => {
      if (!ownerId) return [];
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', ownerId)
        .order('created_at', { ascending: false });
      
      if (error || !Array.isArray(data)) throw new Error('Impossible de charger les notifications');
      return data;
    },
    enabled: !!ownerId,
  });

  const notifications = ownerId ? rows.flatMap(row => {
    const notification = ownedNotification(row, ownerId);
    return notification ? [notification] : [];
  }) : [];

  useEffect(() => {
    if (ownerId && isError) toast.error('Impossible de charger les notifications', { id: `notifications-load:${ownerId}` });
  }, [ownerId, isError]);

  // Count unread notifications
  const unreadCount = notifications.filter(n => !n.read).length;

  // Subscribe to realtime notifications
  useEffect(() => {
    if (!ownerId) return;
    const current = captureRequest();
    let active = true;
    const displayed = new Set<string>();

    const channel = supabase
      .channel(`notifications-realtime:${ownerId}:${channelId}:${++channelLifetime.current}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'purama_ai',
          table: 'notifications',
          filter: `user_id=eq.${ownerId}`,
        },
        (payload) => {
          if (!active || !current()) return;
          const newNotification = ownedNotification(payload.new, ownerId);
          if (!newNotification) return;
          
          // Show toast for new notification
          const icons: Record<NotificationType, string> = {
            task_completed: '✅',
            question: '❓',
            daily_report: '📊',
            alert: '⚠️',
          };
          
          const toastId = `notification:${ownerId}:${newNotification.id}`;
          displayed.add(toastId);
          toast(newNotification.title, {
            id: toastId,
            description: newNotification.message,
            icon: icons[newNotification.type],
            action: newNotification.action_url ? {
              label: 'Voir',
              onClick: () => {
                if (active && current()) window.location.href = newNotification.action_url!;
              },
            } : undefined,
          });

          // Refresh notifications list
          void queryClient.invalidateQueries({ queryKey: ['notifications', ownerId] });
        }
      )
      .subscribe();

    return () => {
      active = false;
      for (const id of displayed) toast.dismiss(id);
      void supabase.removeChannel(channel);
    };
  }, [ownerId, queryClient, captureRequest, channelId]);

  const mutationError = (_error: Error, request: MutationOwner) => {
    if (request.current()) toast.error('Impossible de modifier les notifications');
  };

  // Mark single notification as read
  const markAsRead = useMutation<MutationOwner, Error, OwnedMutation<string>>({
    mutationKey: ['notifications-read', ownerId],
    retry: false,
    mutationFn: async ({ value: notificationId, ownerId, current }: OwnedMutation<string>) => {
      if (!ownerId || !current()) throw new Error('Session indisponible');
      if (typeof notificationId !== 'string' || !notificationId.trim()) throw new Error('Notification invalide');
      const { data, error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('id', notificationId)
        .eq('user_id', ownerId)
        .select('id,user_id,read')
        .maybeSingle();
      
      if (error || !data || data.id !== notificationId || data.user_id !== ownerId || data.read !== true) {
        throw new Error('Modification non confirmée');
      }
      return { ownerId, current };
    },
    onSuccess: receipt => {
      if (receipt.current()) void queryClient.invalidateQueries({ queryKey: ['notifications', receipt.ownerId] });
    },
    onError: mutationError,
  });

  // Mark all notifications as read
  const markAllAsRead = useMutation<MutationOwner, Error, OwnedMutation<void>>({
    mutationKey: ['notifications-read-all', ownerId],
    retry: false,
    mutationFn: async ({ ownerId, current }: OwnedMutation<void>) => {
      if (!ownerId || !current()) throw new Error('Session indisponible');
      const { data, error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('user_id', ownerId)
        .or('read.eq.false,read.is.null')
        .select('id,user_id,read');
      
      if (error || !Array.isArray(data) || data.some(row => row.user_id !== ownerId || row.read !== true || typeof row.id !== 'string' || !row.id)) {
        throw new Error('Modification non confirmée');
      }
      return { ownerId, current, confirmedCount: data.length };
    },
    onSuccess: receipt => {
      if (!receipt.current()) return;
      void queryClient.invalidateQueries({ queryKey: ['notifications', receipt.ownerId] });
      const count = receipt.confirmedCount ?? 0;
      if (count > 0) toast.success(`${count} notification${count > 1 ? 's' : ''} marquée${count > 1 ? 's' : ''} comme lue${count > 1 ? 's' : ''}`);
      else toast('Aucune notification modifiée');
    },
    onError: mutationError,
  });

  // Delete notification
  const deleteNotification = useMutation<MutationOwner, Error, OwnedMutation<string>>({
    mutationKey: ['notifications-delete', ownerId],
    retry: false,
    mutationFn: async ({ value: notificationId, ownerId, current }: OwnedMutation<string>) => {
      if (!ownerId || !current()) throw new Error('Session indisponible');
      if (typeof notificationId !== 'string' || !notificationId.trim()) throw new Error('Notification invalide');
      const { data, error } = await supabase
        .from('notifications')
        .delete()
        .eq('id', notificationId)
        .eq('user_id', ownerId)
        .select('id,user_id')
        .maybeSingle();
      
      if (error || !data || data.id !== notificationId || data.user_id !== ownerId) throw new Error('Suppression non confirmée');
      return { ownerId, current };
    },
    onSuccess: receipt => {
      if (receipt.current()) void queryClient.invalidateQueries({ queryKey: ['notifications', receipt.ownerId] });
    },
    onError: mutationError,
  });

  return {
    notifications,
    unreadCount,
    isLoading,
    isError,
    isFetching,
    refetch: () => {
      const request = input(undefined);
      if (request.ownerId && request.current()) return refetch();
    },
    markAsRead: bindNotificationMutation(markAsRead, input<string>),
    markAllAsRead: bindNotificationMutation(markAllAsRead, input<void>),
    deleteNotification: bindNotificationMutation(deleteNotification, input<string>),
  };
}

export function useNotificationPreferences() {
  const { user } = useAuth();
  const ownerId = user?.id;
  const queryClient = useQueryClient();
  const { input } = useNotificationOwner(ownerId);

  const { data: preferences, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['notification-preferences', ownerId],
    queryFn: async () => {
      if (!ownerId) return null;
      
      const { data, error } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('user_id', ownerId)
        .maybeSingle();
      
      if (error) throw new Error('Impossible de charger les préférences');
      
      // Return default preferences if none exist
      if (data === null) {
        return {
          id: '',
          user_id: ownerId,
          email_enabled: true,
          task_completed_enabled: true,
          question_enabled: true,
          daily_report_enabled: true,
          alert_enabled: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as NotificationPreferences;
      }
      
      return ownedPreferences(data, ownerId);
    },
    enabled: !!ownerId,
  });

  useEffect(() => {
    if (ownerId && isError) toast.error('Impossible de charger les préférences', { id: `notification-preferences-load:${ownerId}` });
  }, [ownerId, isError]);

  const updatePreferences = useMutation<MutationOwner, Error, OwnedMutation<NotificationPreferencePatch>>({
    mutationKey: ['notification-preferences-update', ownerId],
    retry: false,
    mutationFn: async ({ value: newPreferences, ownerId, current }: OwnedMutation<NotificationPreferencePatch>) => {
      if (!ownerId || !current()) throw new Error('Session indisponible');
      const patch = preferencePatch(newPreferences);
      // The existing unique user_id constraint makes creation/update atomic.
      const { data, error } = await supabase
        .from('notification_preferences')
        .upsert({ ...patch, user_id: ownerId }, { onConflict: 'user_id' })
        .select('*')
        .single();
      if (error) throw new Error('Enregistrement des préférences non confirmé');
      const saved = ownedPreferences(data, ownerId);
      if (Object.keys(patch).some(key => saved[key as PreferenceKey] !== patch[key as PreferenceKey])) {
        throw new Error('Enregistrement des préférences non confirmé');
      }
      return { ownerId, current };
    },
    onSuccess: receipt => {
      if (!receipt.current()) return;
      void queryClient.invalidateQueries({ queryKey: ['notification-preferences', receipt.ownerId] });
      toast.success('Préférences mises à jour');
    },
    onError: (_error: Error, request) => {
      if (request.current()) toast.error('Impossible de modifier les préférences');
    },
  });

  return {
    preferences: ownerId ? preferences : null,
    isLoading,
    isError,
    isFetching,
    refetch: () => {
      const request = input(undefined);
      if (request.ownerId && request.current()) return refetch();
    },
    updatePreferences: bindNotificationMutation(updatePreferences, input<NotificationPreferencePatch>),
  };
}
