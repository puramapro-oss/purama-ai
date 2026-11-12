// Page Entraide — réseau d'entraide entre membres Purama AI (mise en relation, missions collectives, contact sécurisé).
// Vocabulaire adapté domaine assistant généraliste (Loi 12) : "coup de main", "partage", "réseau d'entraide".
// Design GOD MODE V3 (glass, dark mode, tokens §4), responsive 375px, VRAIS fetch (0 mock), loading/error/empty states.

import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  UsersRound,
  UserPlus,
  MessageSquare,
  Calendar,
  MapPin,
  Star,
  AlertCircle,
  Loader2,
  Send,
  Users,
  CheckCircle,
  XCircle,
  Clock,
  Shield,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const DAYS_FR: Record<string, string> = {
  mon: 'Lun',
  tue: 'Mar',
  wed: 'Mer',
  thu: 'Jeu',
  fri: 'Ven',
  sat: 'Sam',
  sun: 'Dim',
};

interface ProfileUpdate {
  skills_offered: string[];
  skills_needed: string[];
  availability_days: string[];
  radius_km: number | null;
}

interface MutualAidMatch {
  userId: string;
  score: number;
  reasons: string[];
}

interface CollectiveMission {
  id: string;
  organizer_id: string;
  version: number;
  title: string;
  description: string;
  status: 'ouverte' | 'prete' | 'en_cours' | 'terminee' | 'annulee';
  min_participants: number;
  max_participants: number | null;
  missions_collectives_participants?: Array<{ user_id: string; joined_at?: string }>;
}

type MissionAction = 'join' | 'leave' | 'start' | 'complete' | 'cancel';

interface MissionActionAttempt {
  actorId: string;
  missionId: string;
  action: MissionAction;
  body: { request_id: string; expected_version?: number };
  message?: string;
}

interface CreateMissionAttempt {
  actorId: string;
  signature: string;
  body: {
    title: string;
    description: string;
    min_participants: number;
    max_participants: number | null;
    request_id: string;
  };
}

interface MissionMutationResponse {
  mission: CollectiveMission;
  replayed: boolean;
}

const MISSION_STATUS_LABELS: Record<CollectiveMission['status'], string> = {
  ouverte: 'Ouverte',
  prete: 'Prête',
  en_cours: 'En cours',
  terminee: 'Terminée',
  annulee: 'Annulée',
};

const MISSION_ACTION_LABELS: Record<MissionAction, { label: string; pending: string; success: string }> = {
  join: { label: 'Rejoindre', pending: 'Inscription en cours…', success: 'Mission rejointe' },
  leave: { label: 'Quitter', pending: 'Retrait en cours…', success: 'Participation quittée' },
  start: { label: 'Démarrer', pending: 'Démarrage en cours…', success: 'Mission démarrée' },
  complete: { label: 'Terminer', pending: 'Clôture en cours…', success: 'Mission terminée' },
  cancel: { label: 'Annuler', pending: 'Annulation en cours…', success: 'Mission annulée' },
};

class MissionRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'MissionRequestError';
  }
}

async function postMissionRequest(
  url: string,
  token: string,
  body: MissionActionAttempt['body'] | CreateMissionAttempt['body']
): Promise<MissionMutationResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new MissionRequestError(
        response.status,
        typeof data?.error === 'string' ? data.error : 'request_failed',
        typeof data?.message === 'string' ? data.message : 'La demande n’a pas pu être confirmée.'
      );
    }
    if (!data?.mission || typeof data.mission.id !== 'string' || typeof data.replayed !== 'boolean') {
      throw new Error('Réponse de mission invalide');
    }
    return data as MissionMutationResponse;
  } finally {
    window.clearTimeout(timeout);
  }
}

function keepMissionAttempt(error: unknown): boolean {
  return !(error instanceof MissionRequestError) || error.status >= 500 ||
    error.status === 401 || error.status === 429;
}

function missionRequestMessage(error: unknown): string {
  return error instanceof MissionRequestError
    ? error.message
    : 'La réponse n’a pas été reçue. Réessaie cette demande pour vérifier son résultat.';
}

interface ContactRequest {
  id: string;
  status: string;
  requester_id: string;
  recipient_id: string;
  created_at: string;
}

export default function Entraide() {
  const { user, session } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'profil' | 'missions' | 'contacts'>('profil');
  const [missionTitle, setMissionTitle] = useState('');
  const [missionDescription, setMissionDescription] = useState('');
  const createAttemptRef = useRef<CreateMissionAttempt | null>(null);
  const createInFlightRef = useRef(false);
  const [createErrorMessage, setCreateErrorMessage] = useState<string | null>(null);
  const missionInFlightRef = useRef(new Set<string>());
  const missionRetryRef = useRef(new Map<string, MissionActionAttempt>());
  const [pendingMissionActions, setPendingMissionActions] = useState<Record<string, MissionAction>>({});
  const [missionRetries, setMissionRetries] = useState<Record<string, MissionActionAttempt>>({});

  const token = session?.access_token ? `Bearer ${session.access_token}` : null;

  const {
    data: profilData,
    isLoading: profilLoading,
    error: profilError,
  } = useQuery({
    queryKey: ['entraide-profil', user?.id],
    queryFn: async () => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-profil`, {
        headers: { Authorization: token },
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!user && !!token,
  });

  const {
    data: matchesData,
    isLoading: matchesLoading,
    error: matchesError,
  } = useQuery({
    queryKey: ['entraide-matches', user?.id],
    queryFn: async () => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-matches`,
        { headers: { Authorization: token } }
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!user && !!token && activeTab === 'profil',
  });

  const {
    data: missionsData,
    isLoading: missionsLoading,
    error: missionsError,
  } = useQuery({
    queryKey: ['entraide-missions', user?.id],
    queryFn: async () => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-missions`,
        { headers: { Authorization: token } }
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!user && !!token && activeTab === 'missions',
  });

  const {
    data: contactsData,
    isLoading: contactsLoading,
    error: contactsError,
  } = useQuery({
    queryKey: ['entraide-contacts', user?.id],
    queryFn: async () => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-contact`,
        { headers: { Authorization: token } }
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!user && !!token && activeTab === 'contacts',
  });

  const updateProfilMutation = useMutation({
    mutationFn: async (data: ProfileUpdate) => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-profil`, {
        method: 'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entraide-profil'] });
      toast.success('Profil mis à jour');
    },
    onError: (error: Error) => {
      toast.error(`Erreur: ${error.message}`);
    },
  });

  const sendContactMutation = useMutation({
    mutationFn: async (recipientId: string) => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-contact`, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient_id: recipientId,
          message: "Bonjour, j’aimerais échanger avec vous dans le réseau d’entraide PURAMA AI.",
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entraide-contacts'] });
      toast.success('Demande de contact envoyée');
    },
    onError: (error: Error) => toast.error(`Erreur: ${error.message}`),
  });

  const respondContactMutation = useMutation({
    mutationFn: async ({ requestId, response }: { requestId: string; response: 'accept' | 'decline' | 'block' }) => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-contact/${requestId}/respond`,
        {
          method: 'POST',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ response }),
        }
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entraide-contacts'] });
      toast.success('Demande mise à jour');
    },
    onError: (error: Error) => toast.error(`Erreur: ${error.message}`),
  });

  const createMissionMutation = useMutation({
    mutationFn: async (attempt: CreateMissionAttempt) => {
      if (!token) throw new Error('Non authentifié');
      return postMissionRequest(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-missions`,
        token,
        attempt.body
      );
    },
    retry: false,
    onSuccess: async (result, attempt) => {
      if (createAttemptRef.current?.body.request_id === attempt.body.request_id) {
        createAttemptRef.current = null;
      }
      setCreateErrorMessage(null);
      setMissionTitle('');
      setMissionDescription('');
      toast.success(result.replayed ? 'Réponse de la création précédente retrouvée' : 'Mission collective créée');
      await queryClient.invalidateQueries({ queryKey: ['entraide-missions', attempt.actorId] });
    },
    onError: (error: Error, attempt) => {
      if (!keepMissionAttempt(error) && createAttemptRef.current?.body.request_id === attempt.body.request_id) {
        createAttemptRef.current = null;
      }
      const message = missionRequestMessage(error);
      setCreateErrorMessage(message);
      toast.error(message);
      if (error instanceof MissionRequestError && [403, 404, 409].includes(error.status)) {
        void queryClient.invalidateQueries({ queryKey: ['entraide-missions', attempt.actorId] });
      }
    },
    onSettled: () => { createInFlightRef.current = false; },
  });

  const submitMissionCreation = () => {
    if (!user || !token || createInFlightRef.current || !missionTitle.trim()) return;
    const payload = {
      title: missionTitle.trim(),
      description: missionDescription.trim(),
      min_participants: 2,
      max_participants: null,
    };
    const signature = JSON.stringify(payload);
    const previous = createAttemptRef.current;
    const attempt: CreateMissionAttempt = previous?.actorId === user.id && previous.signature === signature
      ? previous
      : { actorId: user.id, signature, body: { ...payload, request_id: crypto.randomUUID() } };
    createAttemptRef.current = attempt;
    createInFlightRef.current = true;
    setCreateErrorMessage(null);
    createMissionMutation.mutate(attempt);
  };

  const clearMissionRetry = (key: string) => {
    missionRetryRef.current.delete(key);
    setMissionRetries((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const runMissionAction = async (
    mission: CollectiveMission,
    action: MissionAction,
    retryAttempt?: MissionActionAttempt
  ) => {
    if (!user || !token) return;
    const key = `${user.id}:${mission.id}`;
    if (missionInFlightRef.current.has(key)) return;
    if (missionRetryRef.current.has(key) && !retryAttempt) return;
    if (retryAttempt && (retryAttempt.actorId !== user.id || retryAttempt.missionId !== mission.id)) return;
    const organizerAction = action === 'start' || action === 'complete' || action === 'cancel';
    if (!retryAttempt && organizerAction && !Number.isInteger(mission.version)) {
      toast.error('Actualise cette mission avant de la modifier.');
      await queryClient.invalidateQueries({ queryKey: ['entraide-missions', user.id] });
      return;
    }
    const attempt: MissionActionAttempt = retryAttempt ?? {
      actorId: user.id,
      missionId: mission.id,
      action,
      body: {
        request_id: crypto.randomUUID(),
        ...(organizerAction ? { expected_version: mission.version } : {}),
      },
    };
    missionInFlightRef.current.add(key);
    setPendingMissionActions((current) => ({ ...current, [key]: attempt.action }));
    try {
      const result = await postMissionRequest(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-missions/${encodeURIComponent(attempt.missionId)}/${attempt.action}`,
        token,
        attempt.body
      );
      clearMissionRetry(key);
      toast.success(result.replayed ? 'Réponse de la demande précédente retrouvée' : MISSION_ACTION_LABELS[attempt.action].success);
      // A replay may contain an older snapshot. GET remains the source for the displayed state.
      await queryClient.invalidateQueries({ queryKey: ['entraide-missions', attempt.actorId] });
    } catch (error) {
      const message = missionRequestMessage(error);
      if (keepMissionAttempt(error)) {
        const retained = { ...attempt, message };
        missionRetryRef.current.set(key, retained);
        setMissionRetries((current) => ({ ...current, [key]: retained }));
      } else {
        clearMissionRetry(key);
      }
      toast.error(message);
      if (error instanceof MissionRequestError && [403, 404, 409].includes(error.status)) {
        await queryClient.invalidateQueries({ queryKey: ['entraide-missions', attempt.actorId] });
      }
    } finally {
      missionInFlightRef.current.delete(key);
      setPendingMissionActions((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="max-w-md w-full glass-brutal">
          <CardContent className="p-6 text-center space-y-4">
            <Shield className="w-12 h-12 mx-auto text-red-400" />
            <p className="text-muted-foreground">Connecte-toi pour accéder au réseau d'entraide.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const tabs = [
    { id: 'profil' as const, label: 'Mon Profil', icon: UsersRound },
    { id: 'missions' as const, label: 'Missions Collectives', icon: Users },
    { id: 'contacts' as const, label: 'Mes Contacts', icon: MessageSquare },
  ];

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-2"
        >
          <h1 className="text-3xl md:text-4xl font-orbitron font-bold text-foreground">
            Réseau d'Entraide
          </h1>
          <p className="text-muted-foreground">
            Trouve des membres pour t'entraider, rejoins des missions collectives, échange en sécurité.
          </p>
        </motion.div>

        <div className="flex gap-2 overflow-x-auto pb-2">
          {tabs.map((tab) => (
            <Button
              key={tab.id}
              variant={activeTab === tab.id ? 'default' : 'outline'}
              className="flex-shrink-0"
              onClick={() => setActiveTab(tab.id)}
            >
              <tab.icon className="w-4 h-4 mr-2" />
              {tab.label}
            </Button>
          ))}
        </div>

        {activeTab === 'profil' && (
          <div className="space-y-6">
            <Card className="glass-brutal">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UsersRound className="w-5 h-5" />
                  Ton Profil d'Entraide
                </CardTitle>
              </CardHeader>
              <CardContent>
                {profilLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : profilError ? (
                  <div className="text-center py-8 space-y-2">
                    <AlertCircle className="w-8 h-8 mx-auto text-red-400" />
                    <p className="text-muted-foreground">
                      Erreur: {profilError instanceof Error ? profilError.message : 'Inconnue'}
                    </p>
                  </div>
                ) : !profilData?.profil ? (
                  <div className="text-center py-8 space-y-4">
                    <p className="text-muted-foreground">Tu n'as pas encore de profil d'entraide.</p>
                    <Button
                      onClick={() => {
                        updateProfilMutation.mutate({
                          skills_offered: [],
                          skills_needed: [],
                          availability_days: [],
                          radius_km: null,
                        });
                      }}
                    >
                      Créer mon profil
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Compétences offertes:</p>
                      <p className="text-foreground">
                        {profilData.profil.skills_offered?.length > 0
                          ? profilData.profil.skills_offered.join(', ')
                          : 'Aucune'}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Compétences recherchées:</p>
                      <p className="text-foreground">
                        {profilData.profil.skills_needed?.length > 0
                          ? profilData.profil.skills_needed.join(', ')
                          : 'Aucune'}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Disponibilité:</p>
                      <p className="text-foreground">
                        {profilData.profil.availability_days?.length > 0
                          ? profilData.profil.availability_days.map((d: string) => DAYS_FR[d] || d).join(', ')
                          : 'Non renseignée'}
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="glass-brutal">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Star className="w-5 h-5" />
                  Suggestions de Membres ({matchesData?.matches?.length ?? 0})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {matchesLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : matchesError ? (
                  <div className="text-center py-8 space-y-2">
                    <AlertCircle className="w-8 h-8 mx-auto text-red-400" />
                    <p className="text-muted-foreground">
                      Erreur: {matchesError instanceof Error ? matchesError.message : 'Inconnue'}
                    </p>
                  </div>
                ) : !matchesData?.matches || matchesData.matches.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground">
                      Aucune suggestion pour l'instant. Complete ton profil pour améliorer les matchs!
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {matchesData.matches.slice(0, 10).map((match: MutualAidMatch) => (
                      <div
                        key={match.userId}
                        className="p-3 rounded-lg bg-secondary/30 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3">
                          <UserPlus className="w-5 h-5 text-primary" />
                          <div>
                            <p className="text-sm font-medium">Membre {match.userId.slice(0, 8)}</p>
                            <p className="text-xs text-muted-foreground">
                              Score: {match.score}/100 • {match.reasons.join(', ')}
                            </p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={sendContactMutation.isPending}
                          onClick={() => sendContactMutation.mutate(match.userId)}
                        >
                          <Send className="w-4 h-4 mr-1" />
                          Contacter
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === 'missions' && (
          <div className="space-y-4">
            <Card className="glass-brutal">
              <CardHeader>
                <CardTitle>Créer une mission collective</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  value={missionTitle}
                  onChange={(event) => { setMissionTitle(event.target.value); setCreateErrorMessage(null); }}
                  aria-label="Titre de la mission"
                  placeholder="Titre de la mission"
                  maxLength={200}
                  disabled={createMissionMutation.isPending}
                />
                <textarea aria-label="Décris le coup de main collectif"
                  value={missionDescription}
                  onChange={(event) => { setMissionDescription(event.target.value); setCreateErrorMessage(null); }}
                  placeholder="Décris le coup de main collectif"
                  maxLength={2000}
                  disabled={createMissionMutation.isPending}
                  className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                {createErrorMessage && <p role="status" className="text-sm text-red-400">{createErrorMessage}</p>}
                <Button
                  disabled={!missionTitle.trim() || createMissionMutation.isPending}
                  onClick={submitMissionCreation}
                >
                  {createMissionMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Création en cours…</>
                  ) : createErrorMessage ? 'Réessayer la création' : 'Créer à partir de 2 membres'}
                </Button>
              </CardContent>
            </Card>
            <Card className="glass-brutal">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="w-5 h-5" />
                  Missions Collectives ({missionsData?.missions?.length ?? 0})
                </CardTitle>
              </CardHeader>
              <CardContent>
              {missionsLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : missionsError ? (
                <div className="text-center py-8 space-y-2">
                  <AlertCircle className="w-8 h-8 mx-auto text-red-400" />
                  <p className="text-muted-foreground">
                    Erreur: {missionsError instanceof Error ? missionsError.message : 'Inconnue'}
                  </p>
                </div>
              ) : !missionsData?.missions || missionsData.missions.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">Aucune mission collective active pour l'instant.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {missionsData.missions.map((mission: CollectiveMission) => {
                    const key = `${user.id}:${mission.id}`;
                    const participants = mission.missions_collectives_participants ?? [];
                    const isParticipant = participants.some((participant) => participant.user_id === user.id);
                    const isOrganizer = mission.organizer_id === user.id;
                    const recruiting = mission.status === 'ouverte' || mission.status === 'prete';
                    const active = recruiting || mission.status === 'en_cours';
                    const full = mission.max_participants !== null && participants.length >= mission.max_participants;
                    const pending = pendingMissionActions[key];
                    const retry = missionRetries[key];
                    const disabled = !!pending || !!retry;
                    const actions: MissionAction[] = [];
                    if (recruiting && !isParticipant && !full) actions.push('join');
                    if (active && isParticipant) actions.push('leave');
                    if (isOrganizer && mission.status === 'prete') actions.push('start');
                    if (isOrganizer && mission.status === 'en_cours') actions.push('complete');
                    if (isOrganizer && active) actions.push('cancel');
                    return <article
                      key={mission.id}
                      aria-label={`Mission : ${mission.title}`}
                      aria-busy={!!pending}
                      className="p-4 rounded-lg bg-secondary/30 space-y-2"
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="font-semibold text-foreground">{mission.title}</h4>
                          <p className="text-sm text-muted-foreground">{mission.description}</p>
                        </div>
                        <Badge>{MISSION_STATUS_LABELS[mission.status] ?? mission.status}</Badge>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {participants.length}/{mission.max_participants ?? '∞'}
                        </span>
                        <span>Min: {mission.min_participants}</span>
                      </div>
                      {recruiting && !isParticipant && full && <p className="text-sm text-muted-foreground">Mission complète</p>}
                      <div className="flex flex-wrap gap-2">
                        {actions.map((action) => (
                          <Button
                            key={action}
                            size="sm"
                            variant="outline"
                            disabled={disabled || ((action === 'start' || action === 'complete' || action === 'cancel') && !Number.isInteger(mission.version))}
                            onClick={() => { void runMissionAction(mission, action); }}
                          >
                            {pending === action && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                            {pending === action ? MISSION_ACTION_LABELS[action].pending : MISSION_ACTION_LABELS[action].label}
                          </Button>
                        ))}
                      </div>
                      {retry && (
                        <div role="status" className="space-y-2 rounded-md border border-amber-500/40 p-3 text-sm">
                          <p>{retry.message}</p>
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" disabled={!!pending} onClick={() => { void runMissionAction(mission, retry.action, retry); }}>
                              Réessayer la demande
                            </Button>
                            <Button size="sm" variant="outline" disabled={!!pending} onClick={() => clearMissionRetry(key)}>
                              Abandonner la reprise
                            </Button>
                          </div>
                          <p className="text-muted-foreground">Abandonner la reprise n’annule pas une action déjà reçue.</p>
                        </div>
                      )}
                    </article>;
                  })}
                </div>
              )}
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === 'contacts' && (
          <Card className="glass-brutal">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="w-5 h-5" />
                Mes Demandes de Contact ({contactsData?.requests?.length ?? 0})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {contactsLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : contactsError ? (
                <div className="text-center py-8 space-y-2">
                  <AlertCircle className="w-8 h-8 mx-auto text-red-400" />
                  <p className="text-muted-foreground">
                    Erreur: {contactsError instanceof Error ? contactsError.message : 'Inconnue'}
                  </p>
                </div>
              ) : !contactsData?.requests || contactsData.requests.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">Aucune demande de contact pour l'instant.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {contactsData.requests.map((request: ContactRequest) => (
                    <div
                      key={request.id}
                      className="p-3 rounded-lg bg-secondary/30 flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3">
                        {request.status === 'pending' ? (
                          <Clock className="w-5 h-5 text-yellow-400" />
                        ) : request.status === 'accepted' ? (
                          <CheckCircle className="w-5 h-5 text-green-400" />
                        ) : (
                          <XCircle className="w-5 h-5 text-red-400" />
                        )}
                        <div>
                          <p className="text-sm font-medium">
                            {request.requester_id === user?.id ? 'Envoyée' : 'Reçue'}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Statut: {request.status} • {new Date(request.created_at).toLocaleDateString('fr-FR')}
                          </p>
                        </div>
                      </div>
                      {request.status === 'pending' && request.recipient_id === user.id ? (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={respondContactMutation.isPending}
                            onClick={() => respondContactMutation.mutate({ requestId: request.id, response: 'accept' })}
                          >
                            Accepter
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={respondContactMutation.isPending}
                            onClick={() => respondContactMutation.mutate({ requestId: request.id, response: 'decline' })}
                          >
                            Refuser
                          </Button>
                        </div>
                      ) : (
                        <Badge>{request.status}</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
