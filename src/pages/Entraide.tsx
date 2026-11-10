import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { UsersRound, UserPlus, MessageSquare, Star, AlertCircle, Loader2, Send, Users, Shield, LockKeyhole, Globe } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EntraideHttpError, requestEntraide } from '@/lib/entraide-http';
import { toast } from 'sonner';

const DAYS_FR = { mon: 'Lundi', tue: 'Mardi', wed: 'Mercredi', thu: 'Jeudi', fri: 'Vendredi', sat: 'Samedi', sun: 'Dimanche' } as const;
type Day = keyof typeof DAYS_FR;
type Tab = 'profil' | 'missions' | 'contacts';
type MissionStatus = 'ouverte' | 'prete' | 'en_cours' | 'terminee' | 'annulee';
type MissionAction = 'join' | 'leave' | 'start' | 'complete' | 'cancel' | 'publish' | 'unpublish';
type ContactResponse = 'accept' | 'decline' | 'block';

interface ProfileUpdate {
  skills_offered: string[];
  skills_needed: string[];
  availability_days: Day[];
  radius_km: number | null;
  location_lat?: number | null;
  location_lng?: number | null;
}
interface ProfileDraft { offered: string; needed: string; days: Day[]; radius: string; clearLocation: boolean }
interface MutualAidMatch { userId: string; score: number; reasons: string[] }
interface CollectiveMission {
  id: string;
  title: string;
  description: string;
  status: MissionStatus;
  organizer_id: string;
  revision: number;
  visibility: 'private' | 'public';
  min_participants: number;
  max_participants: number | null;
  missions_collectives_participants: Array<{ user_id: string; joined_at: string }>;
}
interface ContactRequest {
  id: string;
  status: 'pending' | 'accepted' | 'declined' | 'blocked' | 'expired';
  requester_id: string;
  recipient_id: string;
  message?: string | null;
  created_at: string;
  expires_at?: string | null;
}
interface ProfileResult { profil: ProfileUpdate | null }
interface MatchesResult { matches: MutualAidMatch[]; scanned_profiles?: number; truncated?: boolean }
interface MissionsResult { missions: CollectiveMission[] }
interface ContactsResult { requests: ContactRequest[]; blocked_user_ids: string[] }
interface MissionDraft { title: string; description: string; minimum: string; maximum: string; visibility: 'private' | 'public' }
interface MissionCreate { id: string; title: string; description: string; min_participants: number; max_participants: number; visibility: 'private' | 'public' }
interface RequestIntent { id: string; fingerprint: string }

const EMPTY_MISSION: MissionDraft = { title: '', description: '', minimum: '2', maximum: '10', visibility: 'private' };
const MISSION_LABELS: Record<MissionStatus, string> = { ouverte: 'Recrutement ouvert', prete: 'Prête à démarrer', en_cours: 'En cours', terminee: 'Déclarée terminée', annulee: 'Annulée' };
const CONTACT_LABELS: Record<ContactRequest['status'], string> = { pending: 'En attente', accepted: 'Acceptée', declined: 'Refusée', blocked: 'Contact indisponible', expired: 'Expirée' };
const ACTION_MESSAGES: Record<MissionAction, string> = { join: 'Participation confirmée.', leave: 'Tu as quitté la mission.', start: 'Le démarrage de la mission est enregistré.', complete: 'Ta déclaration de fin est enregistrée.', cancel: 'L’annulation de la mission est enregistrée.', publish: 'La mission est visible dans le réseau.', unpublish: 'La mission est privée. Ses membres conservent leur accès.' };

function toProfileDraft(profile: ProfileUpdate | null | undefined): ProfileDraft {
  return { offered: profile?.skills_offered?.join(', ') ?? '', needed: profile?.skills_needed?.join(', ') ?? '', days: profile?.availability_days ?? [], radius: profile?.radius_km == null ? '' : String(profile.radius_km), clearLocation: false };
}
function parseSkills(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((skill) => skill.trim()).filter(Boolean))];
}
function newIntent(fingerprint: string): RequestIntent {
  return { id: crypto.randomUUID(), fingerprint };
}
function retryRead(failureCount: number, error: Error): boolean {
  return failureCount < 1 && (!(error instanceof EntraideHttpError) || error.status === 0 || error.status >= 500);
}
function contactStatus(request: ContactRequest): ContactRequest['status'] {
  return request.status === 'pending' && request.expires_at && Date.parse(request.expires_at) <= Date.now() ? 'expired' : request.status;
}
function LoadingState({ label }: { label: string }) {
  return <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status"><Loader2 aria-hidden="true" className="h-5 w-5 animate-spin motion-reduce:animate-none" />{label}</div>;
}
function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><AlertCircle aria-hidden="true" className="h-5 w-5 shrink-0 text-destructive" /><p className="min-w-0 flex-1">{error instanceof Error ? error.message : 'La demande n’a pas pu être confirmée.'}</p>{onRetry && <Button type="button" size="sm" variant="outline" onClick={onRetry}>Réessayer</Button>}</div>;
}

export default function Entraide() {
  const { user, session } = useAuth();
  if (!user || !session?.access_token) {
    return <div className="flex min-h-screen items-center justify-center p-4"><Card className="glass-brutal w-full max-w-md"><CardContent className="space-y-4 p-6 text-center"><Shield aria-hidden="true" className="mx-auto h-12 w-12 text-primary" /><h1 className="text-xl font-semibold">Réseau d’entraide</h1><p className="text-muted-foreground">Connecte-toi pour accéder à ton profil, tes missions et tes contacts.</p></CardContent></Card></div>;
  }
  // Une autre session ne réutilise jamais les brouillons ou intentions du membre précédent.
  return <EntraideWorkspace key={user.id} userId={user.id} token={session.access_token} />;
}

function EntraideWorkspace({ userId, token }: { userId: string; token: string }) {
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const [activeTab, setActiveTab] = useState<Tab>('profil');
  const [profileDraft, setProfileDraft] = useState<ProfileDraft | null>(null);
  const [profileValidation, setProfileValidation] = useState('');
  const [missionDraft, setMissionDraft] = useState<MissionDraft>(EMPTY_MISSION);
  const [missionValidation, setMissionValidation] = useState('');
  const [contactMessage, setContactMessage] = useState('Bonjour, j’aimerais échanger avec toi dans le réseau d’entraide.');
  const missionIntent = useRef<RequestIntent | null>(null);
  const contactIntents = useRef(new Map<string, RequestIntent>());

  const profil = useQuery<ProfileResult, Error>({ queryKey: ['entraide-profil', userId], queryFn: ({ signal }) => requestEntraide('entraide-profil', { token, signal }), retry: retryRead });
  const matches = useQuery<MatchesResult, Error>({ queryKey: ['entraide-matches', userId], queryFn: ({ signal }) => requestEntraide('entraide-matches', { token, signal }), enabled: activeTab === 'profil' && !!profil.data?.profil, retry: retryRead });
  const missions = useQuery<MissionsResult, Error>({ queryKey: ['entraide-missions', userId], queryFn: ({ signal }) => requestEntraide('entraide-missions', { token, signal }), enabled: activeTab === 'missions', retry: retryRead });
  const contacts = useQuery<ContactsResult, Error>({ queryKey: ['entraide-contacts', userId], queryFn: ({ signal }) => requestEntraide('entraide-contact', { token, signal }), enabled: activeTab !== 'missions', retry: retryRead });

  const refreshContacts = () => {
    void queryClient.invalidateQueries({ queryKey: ['entraide-contacts', userId] });
    void queryClient.invalidateQueries({ queryKey: ['entraide-matches', userId] });
  };
  const storeContact = (request: ContactRequest) => {
    queryClient.setQueryData<ContactsResult>(['entraide-contacts', userId], (previous) => ({ requests: previous?.requests.some((item) => item.id === request.id) ? previous.requests.map((item) => item.id === request.id ? request : item) : [request, ...(previous?.requests ?? [])], blocked_user_ids: previous?.blocked_user_ids ?? [] }));
  };
  const rememberBlock = (targetId: string) => {
    queryClient.setQueryData<ContactsResult>(['entraide-contacts', userId], (previous) => ({ requests: previous?.requests ?? [], blocked_user_ids: [...new Set([...(previous?.blocked_user_ids ?? []), targetId])] }));
  };
  const updateProfilMutation = useMutation({
    onMutate: () => queryClient.cancelQueries({ queryKey: ['entraide-profil', userId] }),
    mutationFn: (data: ProfileUpdate) => requestEntraide<{ ok: true }>('entraide-profil', { token, method: 'PUT', body: data }),
    onSuccess: (_result, data) => {
      queryClient.setQueryData<ProfileResult>(['entraide-profil', userId], (previous) => ({ profil: { ...previous?.profil, ...data } }));
      setProfileDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['entraide-profil', userId] });
      void queryClient.invalidateQueries({ queryKey: ['entraide-matches', userId] });
      toast.success('Profil d’entraide enregistré.');
    },
  });
  const sendContactMutation = useMutation({
    mutationFn: (body: { id: string; recipient_id: string; message: string }) => requestEntraide<{ request: ContactRequest }>('entraide-contact', { token, method: 'POST', body }),
    onSuccess: ({ request }, body) => {
      contactIntents.current.delete(body.recipient_id);
      storeContact(request);
      refreshContacts();
      toast.success('Demande de contact envoyée.');
    },
  });
  const respondContactMutation = useMutation({
    mutationFn: ({ requestId, response }: { requestId: string; response: ContactResponse; targetId: string }) => requestEntraide<{ request: ContactRequest }>(`entraide-contact/${requestId}/respond`, { token, method: 'POST', body: { response } }),
    onSuccess: ({ request }, variables) => {
      storeContact(request);
      if (variables.response === 'block') rememberBlock(variables.targetId);
      refreshContacts();
      toast.success(variables.response === 'accept' ? 'Demande de contact acceptée.' : variables.response === 'block' ? 'Membre bloqué.' : 'Demande de contact refusée.');
    },
    onError: refreshContacts,
  });
  const blockContactMutation = useMutation({
    mutationFn: (targetId: string) => requestEntraide<{ ok: true }>('entraide-contact/block', { token, method: 'POST', body: { target_id: targetId } }),
    onSuccess: (_result, targetId) => {
      rememberBlock(targetId);
      refreshContacts();
      toast.success('Membre bloqué.');
    },
    onError: refreshContacts,
  });
  const unblockContactMutation = useMutation({
    mutationFn: (targetId: string) => requestEntraide<{ ok: true }>('entraide-contact/unblock', { token, method: 'POST', body: { target_id: targetId } }),
    onSuccess: (_result, targetId) => {
      queryClient.setQueryData<ContactsResult>(['entraide-contacts', userId], (previous) => previous ? { ...previous, blocked_user_ids: (previous.blocked_user_ids ?? []).filter((id) => id !== targetId) } : previous);
      refreshContacts();
      toast.success('Membre débloqué. Les anciennes acceptations restent clôturées.');
    },
    onError: refreshContacts,
  });
  const storeMission = (mission: CollectiveMission) => {
    queryClient.setQueryData<MissionsResult>(['entraide-missions', userId], (previous) => ({ missions: previous?.missions.some((item) => item.id === mission.id) ? previous.missions.map((item) => item.id === mission.id ? mission : item) : [mission, ...(previous?.missions ?? [])] }));
    void queryClient.invalidateQueries({ queryKey: ['entraide-missions', userId] });
  };
  const createMissionMutation = useMutation({
    mutationFn: (body: MissionCreate) => requestEntraide<{ mission: CollectiveMission }>('entraide-missions', { token, method: 'POST', body }),
    onSuccess: ({ mission }) => {
      storeMission(mission);
      setMissionDraft(EMPTY_MISSION);
      missionIntent.current = null;
      toast.success('Mission collective créée.');
    },
  });
  const missionActionMutation = useMutation({
    mutationFn: ({ mission, action }: { mission: CollectiveMission; action: MissionAction }) => requestEntraide<{ mission: CollectiveMission }>(`entraide-missions/${mission.id}/${action}`, { token, method: 'POST', body: action === 'join' || action === 'leave' ? {} : { expected_revision: mission.revision } }),
    onSuccess: ({ mission }, { action }) => {
      storeMission(mission);
      toast.success(ACTION_MESSAGES[action]);
    },
    onError: () => { void queryClient.invalidateQueries({ queryKey: ['entraide-missions', userId] }); },
  });

  // Un brouillon commence à la première saisie. Un refetch ne remplace jamais les champs modifiés.
  const draft = profileDraft ?? toProfileDraft(profil.data?.profil);
  const editProfile = (changes: Partial<ProfileDraft>) => {
    setProfileDraft({ ...draft, ...changes });
    setProfileValidation('');
    updateProfilMutation.reset();
  };
  const submitProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profil.data || updateProfilMutation.isPending) return;
    const offered = parseSkills(draft.offered);
    const needed = parseSkills(draft.needed);
    if ([offered, needed].some((skills) => skills.length > 50 || skills.some((skill) => skill.length > 100))) {
      setProfileValidation('Indique au maximum 50 compétences par champ, de 100 caractères chacune.');
      return;
    }
    const radius = draft.radius === '' ? null : Number(draft.radius);
    if (radius !== null && (!Number.isInteger(radius) || radius < 0 || radius > 20000)) {
      setProfileValidation('Le rayon doit être un nombre entier de 0 à 20 000 km, ou rester vide.');
      return;
    }
    updateProfilMutation.mutate({ skills_offered: offered, skills_needed: needed, availability_days: draft.days, radius_km: radius, ...(draft.clearLocation ? { location_lat: null, location_lng: null } : {}) });
  };
  const editMission = (changes: Partial<MissionDraft>) => {
    setMissionDraft((previous) => ({ ...previous, ...changes }));
    setMissionValidation('');
    createMissionMutation.reset();
  };
  const submitMission = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createMissionMutation.isPending) return;
    const minimum = Number(missionDraft.minimum);
    const maximum = Number(missionDraft.maximum);
    if (!missionDraft.title.trim()) { setMissionValidation('Donne un titre à la mission.'); return; }
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 2 || maximum > 1000 || maximum < minimum) {
      setMissionValidation('Choisis un minimum et un maximum entiers entre 2 et 1 000, avec un maximum au moins égal au minimum.');
      return;
    }
    const body = { title: missionDraft.title.trim(), description: missionDraft.description.trim(), min_participants: minimum, max_participants: maximum, visibility: missionDraft.visibility };
    const fingerprint = JSON.stringify(body);
    if (missionIntent.current?.fingerprint !== fingerprint) missionIntent.current = newIntent(fingerprint);
    createMissionMutation.mutate({ id: missionIntent.current.id, ...body });
  };
  const sendContact = (recipientId: string) => {
    if (sendContactMutation.isPending) return;
    const message = contactMessage.trim();
    const fingerprint = JSON.stringify({ recipient_id: recipientId, message });
    let intent = contactIntents.current.get(recipientId);
    if (intent?.fingerprint !== fingerprint) { intent = newIntent(fingerprint); contactIntents.current.set(recipientId, intent); }
    sendContactMutation.mutate({ id: intent.id, recipient_id: recipientId, message });
  };
  const contactsBusy = respondContactMutation.isPending || blockContactMutation.isPending || unblockContactMutation.isPending;
  const blockedUserIds = contacts.data?.blocked_user_ids ?? [];

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <motion.header initial={reducedMotion ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-2 text-center">
          <h1 className="font-orbitron text-3xl font-bold text-foreground md:text-4xl">Réseau d’entraide</h1>
          <p className="text-muted-foreground">Partage tes savoir-faire, rassemble des membres autour d’une mission et choisis tes contacts.</p>
        </motion.header>
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as Tab)}>
          <TabsList aria-label="Sections du réseau d’entraide" className="mb-4 grid h-auto w-full grid-cols-3">
            <TabsTrigger value="profil" className="min-w-0 gap-1 px-2 py-2 motion-reduce:transition-none"><UsersRound aria-hidden="true" className="h-4 w-4 shrink-0" />Profil</TabsTrigger>
            <TabsTrigger value="missions" className="min-w-0 gap-1 px-2 py-2 motion-reduce:transition-none"><Users aria-hidden="true" className="h-4 w-4 shrink-0" />Missions</TabsTrigger>
            <TabsTrigger value="contacts" className="min-w-0 gap-1 px-2 py-2 motion-reduce:transition-none"><MessageSquare aria-hidden="true" className="h-4 w-4 shrink-0" />Contacts</TabsTrigger>
          </TabsList>

          <TabsContent value="profil" className="space-y-6">
            <Card className="glass-brutal">
              <CardHeader><CardTitle className="flex items-center gap-2"><UsersRound aria-hidden="true" className="h-5 w-5" />Ton profil d’entraide</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {profil.isPending && <LoadingState label="Chargement de ton profil…" />}
                {profil.error && <ErrorState error={profil.error} onRetry={() => { void profil.refetch(); }} />}
                {profil.data && <form onSubmit={submitProfile} className="space-y-4">
                  {!profil.data.profil && <p className="text-sm text-muted-foreground">Renseigne ce que tu proposes et ce dont tu as besoin pour créer ton profil.</p>}
                  <fieldset disabled={updateProfilMutation.isPending} className="space-y-4">
                    <div className="space-y-2"><label htmlFor="entraide-offered" className="text-sm font-medium">Ce que tu peux partager</label><Input id="entraide-offered" value={draft.offered} onChange={(event) => editProfile({ offered: event.target.value })} placeholder="Ex. : jardinage, réparation de vélo" maxLength={5100} aria-describedby="entraide-skills-help" /></div>
                    <div className="space-y-2"><label htmlFor="entraide-needed" className="text-sm font-medium">Ce que tu recherches</label><Input id="entraide-needed" value={draft.needed} onChange={(event) => editProfile({ needed: event.target.value })} placeholder="Ex. : aide informatique, couture" maxLength={5100} aria-describedby="entraide-skills-help" /><p id="entraide-skills-help" className="text-xs text-muted-foreground">Sépare les compétences par des virgules. Jusqu’à 50 par champ.</p></div>
                    <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Tes disponibilités habituelles</legend><div className="flex flex-wrap gap-2">{(Object.entries(DAYS_FR) as [Day, string][]).map(([day, label]) => <label key={day} className="flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-2 text-sm"><input type="checkbox" checked={draft.days.includes(day)} onChange={(event) => editProfile({ days: event.target.checked ? [...draft.days, day] : draft.days.filter((item) => item !== day) })} className="h-4 w-4 accent-primary" />{label}</label>)}</div></fieldset>
                    <div className="space-y-2"><label htmlFor="entraide-radius" className="text-sm font-medium">Rayon souhaité en kilomètres · facultatif</label><Input id="entraide-radius" type="number" inputMode="numeric" min={0} max={20000} step={1} value={draft.radius} onChange={(event) => editProfile({ radius: event.target.value })} aria-describedby="entraide-radius-help" className="max-w-xs" /><p id="entraide-radius-help" className="text-xs text-muted-foreground">Cette préférence ne suffit pas à localiser un membre. Aucune position n’est demandée sur cet écran.</p></div>
                    {(profil.data.profil?.location_lat != null || profil.data.profil?.location_lng != null) && <div className="space-y-2"><p className="text-sm text-muted-foreground">Ton profil possède déjà une localisation enregistrée.</p><Button type="button" variant="outline" onClick={() => editProfile({ clearLocation: !draft.clearLocation })}>{draft.clearLocation ? 'Conserver ma localisation' : 'Effacer ma localisation'}</Button>{draft.clearLocation && <p role="status" className="text-xs text-muted-foreground">Les coordonnées seront effacées lorsque tu enregistreras ce profil.</p>}</div>}
                  </fieldset>
                  {profileValidation && <p role="alert" className="text-sm text-destructive">{profileValidation}</p>}
                  {updateProfilMutation.error && <ErrorState error={updateProfilMutation.error} />}
                  {updateProfilMutation.isSuccess && <p role="status" className="text-sm text-muted-foreground">Ton profil est enregistré.</p>}
                  <Button type="submit" disabled={updateProfilMutation.isPending} className="gap-2">{updateProfilMutation.isPending && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />}{updateProfilMutation.isPending ? 'Enregistrement…' : 'Enregistrer mon profil'}</Button>
                </form>}
              </CardContent>
            </Card>
            <Card className="glass-brutal">
              <CardHeader><CardTitle className="flex items-center gap-2"><Star aria-hidden="true" className="h-5 w-5" />Des membres avec qui s’entraider</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {profil.isPending ? <LoadingState label="Préparation des suggestions…" /> : !profil.data?.profil ? <p className="py-4 text-sm text-muted-foreground">Enregistre ton profil pour obtenir des suggestions de membres.</p> : <>
                  {matches.isPending && <LoadingState label="Recherche de membres…" />}
                  {matches.error && <ErrorState error={matches.error} onRetry={() => { void matches.refetch(); }} />}
                  {matches.data?.truncated && <p className="text-xs text-muted-foreground">Ces suggestions sont calculées sur un lot limité de profils et ne couvrent pas tout le réseau.</p>}
                  {matches.data?.matches.length === 0 && <p className="py-4 text-sm text-muted-foreground">Aucune suggestion pour l’instant. Tu peux préciser ton profil ou découvrir les missions collectives.</p>}
                  {!!matches.data?.matches.length && <>
                    <div className="space-y-2"><label htmlFor="entraide-contact-message" className="text-sm font-medium">Message joint à ta demande · facultatif</label><Textarea id="entraide-contact-message" value={contactMessage} maxLength={500} disabled={sendContactMutation.isPending} onChange={(event) => { setContactMessage(event.target.value); sendContactMutation.reset(); }} /><p className="text-xs text-muted-foreground">Le membre peut accepter, refuser ou bloquer la demande.</p></div>
                    {contacts.error && <ErrorState error={contacts.error} onRetry={() => { void contacts.refetch(); }} />}
                    {sendContactMutation.error && <ErrorState error={sendContactMutation.error} />}
                    <ul className="space-y-3">{matches.data.matches.map((match) => {
                      const existing = contacts.data?.requests.find((request) => (request.requester_id === match.userId || request.recipient_id === match.userId) && ['pending', 'accepted'].includes(contactStatus(request)));
                      const sent = !!existing;
                      const blocked = blockedUserIds.includes(match.userId);
                      return <li key={match.userId} className="flex flex-col gap-3 rounded-lg bg-secondary/30 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex min-w-0 items-start gap-3"><UserPlus aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" /><div className="min-w-0"><h3 className="text-sm font-medium">Membre {match.userId.slice(0, 8)}</h3><p className="break-words text-xs text-muted-foreground">Compatibilité indicative : {Math.round(match.score)}/100{match.reasons.length ? ` · ${match.reasons.join(' · ')}` : ''}</p></div></div><Button type="button" size="sm" variant="outline" disabled={sendContactMutation.isPending || blocked || contacts.isPending || !!contacts.error} onClick={() => sent ? setActiveTab('contacts') : sendContact(match.userId)} className="shrink-0 gap-2">{!sent && <Send aria-hidden="true" className="h-4 w-4" />}{blocked ? 'Membre bloqué' : sent ? 'Voir la demande' : sendContactMutation.isPending && sendContactMutation.variables?.recipient_id === match.userId ? 'Envoi…' : 'Demander un contact'}</Button></li>;
                    })}</ul>
                  </>}
                </>}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="missions" className="space-y-6">
            <Card className="glass-brutal">
              <CardHeader><CardTitle>Créer une mission collective</CardTitle></CardHeader>
              <CardContent><form onSubmit={submitMission} className="space-y-4">
                <fieldset disabled={createMissionMutation.isPending} className="space-y-4">
                  <div className="space-y-2"><label htmlFor="entraide-mission-title" className="text-sm font-medium">Titre de la mission</label><Input id="entraide-mission-title" value={missionDraft.title} onChange={(event) => editMission({ title: event.target.value })} placeholder="Ex. : créer un jardin partagé" required maxLength={200} /></div>
                  <div className="space-y-2"><label htmlFor="entraide-mission-description" className="text-sm font-medium">Objectif et coup de main attendu</label><Textarea id="entraide-mission-description" value={missionDraft.description} onChange={(event) => editMission({ description: event.target.value })} placeholder="Décris le résultat attendu, l’organisation et les compétences utiles." maxLength={2000} /></div>
                  <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><label htmlFor="entraide-mission-min" className="text-sm font-medium">Participants minimum</label><Input id="entraide-mission-min" type="number" inputMode="numeric" min={2} max={1000} step={1} required value={missionDraft.minimum} onChange={(event) => editMission({ minimum: event.target.value })} /></div><div className="space-y-2"><label htmlFor="entraide-mission-max" className="text-sm font-medium">Participants maximum</label><Input id="entraide-mission-max" type="number" inputMode="numeric" min={2} max={1000} step={1} required value={missionDraft.maximum} onChange={(event) => editMission({ maximum: event.target.value })} /></div></div>
                  <p className="text-xs text-muted-foreground">De 2 à 1 000 membres, organisateur compris. Le minimum doit être atteint pour démarrer.</p>
                  <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Qui peut découvrir cette mission ?</legend><label className="flex items-start gap-3 rounded-md border border-input p-3 text-sm"><input type="radio" name="mission-visibility" value="private" checked={missionDraft.visibility === 'private'} onChange={() => editMission({ visibility: 'private' })} className="mt-1 accent-primary" /><span><span className="font-medium">Privée</span><span className="mt-1 block text-muted-foreground">Visible uniquement de toi et des membres déjà autorisés.</span></span></label><label className="flex items-start gap-3 rounded-md border border-input p-3 text-sm"><input type="radio" name="mission-visibility" value="public" checked={missionDraft.visibility === 'public'} onChange={() => editMission({ visibility: 'public' })} className="mt-1 accent-primary" /><span><span className="font-medium">Publique dans le réseau</span><span className="mt-1 block text-muted-foreground">Le titre, la description et les participants sont visibles aux membres du réseau. Ils peuvent rejoindre la mission tant que le recrutement est ouvert.</span></span></label><p className="text-xs text-muted-foreground">Une mission privée peut être rendue visible plus tard pour accueillir des membres du réseau.</p></fieldset>
                </fieldset>
                {missionValidation && <p role="alert" className="text-sm text-destructive">{missionValidation}</p>}
                {createMissionMutation.error && <ErrorState error={createMissionMutation.error} />}
                <Button type="submit" disabled={createMissionMutation.isPending} className="gap-2">{createMissionMutation.isPending && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />}{createMissionMutation.isPending ? 'Création…' : missionDraft.visibility === 'private' ? 'Créer ma mission privée' : 'Créer et rendre visible au réseau'}</Button>
              </form></CardContent>
            </Card>
            <Card className="glass-brutal">
              <CardHeader><CardTitle className="flex items-center gap-2"><Users aria-hidden="true" className="h-5 w-5" />Missions collectives</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {missions.isPending && <LoadingState label="Chargement des missions…" />}
                {missions.error && <ErrorState error={missions.error} onRetry={() => { void missions.refetch(); }} />}
                {missionActionMutation.error && <ErrorState error={missionActionMutation.error} />}
                {missions.data?.missions.length === 0 && <p className="py-4 text-sm text-muted-foreground">Aucune mission accessible pour l’instant. Crée la première autour d’un objectif concret.</p>}
                {missions.data && <ul className="space-y-4">{missions.data.missions.map((mission) => {
                  const participants = mission.missions_collectives_participants ?? [];
                  const count = participants.length;
                  const owner = mission.organizer_id === userId;
                  const member = participants.some((participant) => participant.user_id === userId);
                  const recruiting = mission.status === 'ouverte' || mission.status === 'prete';
                  const closed = mission.status === 'terminee' || mission.status === 'annulee';
                  const full = mission.max_participants !== null && count >= mission.max_participants;
                  const revisionKnown = Number.isInteger(mission.revision) && mission.revision >= 0;
                  const action = (name: MissionAction) => missionActionMutation.mutate({ mission, action: name });
                  return <li key={mission.id} className="space-y-3 rounded-lg bg-secondary/30 p-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0 space-y-1"><h3 className="break-words font-semibold">{mission.title}</h3>{mission.description && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{mission.description}</p>}</div><Badge className="w-fit shrink-0">{MISSION_LABELS[mission.status] ?? mission.status}</Badge></div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"><span className="flex items-center gap-1"><Users aria-hidden="true" className="h-3 w-3" />{count}{mission.max_participants === null ? '' : ` / ${mission.max_participants}`} participants · minimum {mission.min_participants}</span><span className="flex items-center gap-1">{mission.visibility === 'public' ? <Globe aria-hidden="true" className="h-3 w-3" /> : <LockKeyhole aria-hidden="true" className="h-3 w-3" />}{mission.visibility === 'public' ? 'Publique dans le réseau' : 'Privée'}</span>{owner ? <span>Tu organises cette mission</span> : member ? <span>Tu participes à cette mission</span> : null}</div>
                    {mission.status === 'ouverte' && owner && <p className="text-xs text-muted-foreground">Il manque {Math.max(0, mission.min_participants - count)} participant(s) pour pouvoir démarrer.</p>}
                    {mission.status === 'terminee' && <p className="text-xs text-muted-foreground">Fin déclarée par l’organisateur. Ce statut ne constitue ni une preuve indépendante du résultat ni une autorisation de paiement.</p>}
                    {owner && recruiting && <p className="text-xs text-muted-foreground">{mission.visibility === 'private' ? 'Rendre cette mission visible au réseau partagera son titre, sa description et ses participants avec les membres du réseau.' : 'Masquer cette mission du réseau conserve l’accès de ses participants actuels.'}</p>}
                    <div className="flex flex-wrap gap-2">
                      {!member && !owner && mission.visibility === 'public' && recruiting && <Button type="button" size="sm" variant="outline" disabled={missionActionMutation.isPending || full} onClick={() => action('join')}>{full ? 'Mission complète' : 'Rejoindre la mission'}</Button>}
                      {member && !owner && !closed && <Button type="button" size="sm" variant="outline" disabled={missionActionMutation.isPending} onClick={() => action('leave')}>Quitter la mission</Button>}
                      {owner && mission.status === 'prete' && count >= mission.min_participants && <Button type="button" size="sm" disabled={missionActionMutation.isPending || !revisionKnown} onClick={() => action('start')}>Démarrer la mission</Button>}
                      {owner && mission.status === 'en_cours' && <Button type="button" size="sm" disabled={missionActionMutation.isPending || !revisionKnown} onClick={() => action('complete')}>Déclarer la mission terminée</Button>}
                      {owner && !closed && <Button type="button" size="sm" variant="outline" disabled={missionActionMutation.isPending || !revisionKnown} onClick={() => action('cancel')}>Annuler la mission</Button>}
                      {owner && recruiting && <Button type="button" size="sm" variant="outline" disabled={missionActionMutation.isPending || !revisionKnown} onClick={() => action(mission.visibility === 'private' ? 'publish' : 'unpublish')}>{mission.visibility === 'private' ? 'Rendre visible au réseau' : 'Masquer du réseau'}</Button>}
                    </div>
                    {owner && !closed && !revisionKnown && <p className="text-xs text-destructive">Actualise les missions avant de modifier leur état.</p>}
                    {missionActionMutation.isPending && missionActionMutation.variables.mission.id === mission.id && <p role="status" className="text-sm text-muted-foreground">Confirmation de l’action en cours…</p>}
                  </li>;
                })}</ul>}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="contacts">
            <Card className="glass-brutal">
              <CardHeader><CardTitle className="flex items-center gap-2"><MessageSquare aria-hidden="true" className="h-5 w-5" />Mes demandes de contact</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">Tu gardes le choix des personnes avec qui entrer en relation. L’acceptation est enregistrée ici ; cet écran ne comporte pas de messagerie.</p>
                {contacts.isPending && <LoadingState label="Chargement des demandes…" />}
                {contacts.error && <ErrorState error={contacts.error} onRetry={() => { void contacts.refetch(); }} />}
                {respondContactMutation.error && <ErrorState error={respondContactMutation.error} />}
                {blockContactMutation.error && <ErrorState error={blockContactMutation.error} />}
                {unblockContactMutation.error && <ErrorState error={unblockContactMutation.error} />}
                {blockedUserIds.length > 0 && <section aria-labelledby="entraide-blocked-heading" className="space-y-3 rounded-lg border border-input p-4"><h3 id="entraide-blocked-heading" className="text-sm font-semibold">Mes blocages</h3><p className="text-xs text-muted-foreground">Débloquer autorise de nouvelles demandes. Les anciennes acceptations ne sont pas rétablies automatiquement.</p><ul className="space-y-2">{blockedUserIds.map((targetId) => <li key={targetId} className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm">Membre {targetId.slice(0, 8)}</span><Button type="button" size="sm" variant="outline" disabled={contactsBusy} onClick={() => unblockContactMutation.mutate(targetId)}>{unblockContactMutation.isPending && unblockContactMutation.variables === targetId ? 'Déblocage…' : 'Débloquer'}</Button></li>)}</ul></section>}
                {contacts.data?.requests.length === 0 && <p className="py-4 text-sm text-muted-foreground">Tu n’as pas encore de demande de contact. Les suggestions de ton profil permettent d’en envoyer.</p>}
                {contacts.data && <ul className="space-y-3">{contacts.data.requests.map((request) => {
                  const incoming = request.recipient_id === userId;
                  const targetId = incoming ? request.requester_id : request.recipient_id;
                  const status = contactStatus(request);
                  const blocked = blockedUserIds.includes(targetId);
                  const pendingIncoming = status === 'pending' && incoming && !blocked;
                  const respond = (response: ContactResponse) => respondContactMutation.mutate({ requestId: request.id, response, targetId });
                  const created = new Date(request.created_at);
                  return <li key={request.id} className="space-y-3 rounded-lg bg-secondary/30 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-medium">{incoming ? 'Reçue de' : 'Envoyée à'} Membre {targetId.slice(0, 8)}</h3>{!Number.isNaN(created.getTime()) && <p className="text-xs text-muted-foreground">{created.toLocaleDateString('fr-FR')}</p>}</div><Badge variant="outline">{blocked ? 'Contact indisponible' : CONTACT_LABELS[status] ?? status}</Badge></div>
                    {request.message && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{request.message}</p>}
                    <div className="flex flex-wrap gap-2">
                      {pendingIncoming && <><Button type="button" size="sm" disabled={contactsBusy} onClick={() => respond('accept')}>Accepter</Button><Button type="button" size="sm" variant="outline" disabled={contactsBusy} onClick={() => respond('decline')}>Refuser</Button></>}
                      {!blocked && <Button type="button" size="sm" variant="outline" disabled={contactsBusy} onClick={() => pendingIncoming ? respond('block') : blockContactMutation.mutate(targetId)} className="gap-1"><Shield aria-hidden="true" className="h-4 w-4" />Bloquer ce membre</Button>}
                    </div>
                    {((respondContactMutation.isPending && respondContactMutation.variables.requestId === request.id) || (blockContactMutation.isPending && blockContactMutation.variables === targetId)) && <p role="status" className="text-sm text-muted-foreground">Enregistrement de ton choix…</p>}
                  </li>;
                })}</ul>}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
