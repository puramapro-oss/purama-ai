import { useId, useState, type FormEvent } from 'react';
import { Bell, CalendarClock, Check, Mail, MessageSquare, Pause, Phone, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useIaoRoutines, routineFingerprint } from '@/hooks/useIaoRoutines';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { normalizeRoutineInput, type RoutineSchedule } from '../../../karta/src/routines/contracts';
import { routineInstantFromLocal } from '../../../karta/src/routines/schedule';
import type { Routine, RoutineChannel, RoutineInput } from '@/lib/iao-routines-client';

const CHANNELS: Array<{ value: RoutineChannel; label: string; icon: typeof Phone }> = [
  { value: 'call', label: 'Appel téléphonique', icon: Phone },
  { value: 'in_app', label: 'Message dans IAO', icon: MessageSquare },
  { value: 'push', label: 'Notification', icon: Bell },
  { value: 'email', label: 'E-mail', icon: Mail },
];
const DAYS = [{ value: 1, name: 'Lundi', short: 'Lun' }, { value: 2, name: 'Mardi', short: 'Mar' },
  { value: 3, name: 'Mercredi', short: 'Mer' }, { value: 4, name: 'Jeudi', short: 'Jeu' },
  { value: 5, name: 'Vendredi', short: 'Ven' }, { value: 6, name: 'Samedi', short: 'Sam' },
  { value: 0, name: 'Dimanche', short: 'Dim' }];
const STATUS: Record<string, string> = {
  pending: 'En attente', processing: 'Préparation en cours', completed: 'Traitement terminé',
  cancelled: 'Annulé', skipped: 'Non envoyé', failed: 'Échec', partial: 'Partiellement transmis',
  unknown: 'Résultat à vérifier', sending: 'Transmission en cours', accepted: 'Accepté par le service',
};
const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

function timezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris'; }
  catch { return 'Europe/Paris'; }
}

function defaultRoutine(active: boolean): RoutineInput {
  return {
    name: 'Mon bilan du matin', instruction: 'Présente les travaux terminés, les blocages et les décisions qui attendent ma réponse.',
    enabled: active, schedule: { kind: 'daily', time: '08:30', timezone: timezone() },
    channels: ['in_app'], deliveryMode: 'parallel', agentTypes: [], length: 'standard',
    quietHours: { start: '22:00', end: '08:00' }, pausedUntil: null, onlyIfNew: true,
    maxCallMinutes: 2, monthlyCallMinutes: 30,
  };
}

function formatDate(at: string, zone?: string): string {
  try { return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(new Date(at)); }
  catch { return 'Date indisponible'; }
}

function wallValue(at: string | null, zone: string): string {
  if (!at) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
  } catch { return ''; }
}

function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.kind === 'event') return ({ completed: 'Quand un travail est terminé', blocked: 'Quand un travail est bloqué',
    decision: 'Quand une décision est nécessaire' })[schedule.event];
  if (schedule.kind === 'once') return `${formatDate(schedule.at, schedule.timezone)} · ${schedule.timezone}`;
  const days = schedule.kind === 'daily' ? 'Chaque jour' : DAYS.filter(day => schedule.days.includes(day.value)).map(day => day.short).join(', ');
  return `${days} à ${schedule.time} · ${schedule.timezone}`;
}

/** Remount drafts on account changes; a different account never sees the former user's editor. */
export function IaoRoutinesSettings() {
  const { user } = useAuth();
  return <RoutinesPanel key={user?.id ?? 'anonymous'} />;
}

function RoutinesPanel() {
  const api = useIaoRoutines();
  const prefix = useId();
  const [editor, setEditor] = useState<{ id: string; revision: number; config: RoutineInput } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const field = (name: string) => `${prefix}-${name}`;
  const busy = api.busy !== null;
  const unavailable = !api.data || api.error !== null;
  const run = (operation: () => Promise<unknown>) => { void operation().catch(() => { /* The scoped hook renders the error. */ }); };
  const caps = api.data?.capabilities;

  const edit = (routine?: Routine, preset: 'morning' | 'evening' | 'decision' = 'morning') => {
    api.clearFeedback(); setFormError(null);
    const config = routine ? structuredClone(routine.config) : defaultRoutine(caps?.routines === true);
    if (!routine && preset === 'evening') {
      config.name = 'Mon bilan de la journée'; config.schedule = { kind: 'daily', time: '18:00', timezone: timezone() };
    }
    if (!routine && preset === 'decision') {
      config.name = 'Une décision m’attend'; config.schedule = { kind: 'event', event: 'decision', timezone: timezone() };
      config.instruction = 'Présente la décision attendue, les informations disponibles et les prochaines étapes.';
    }
    setEditor({ id: routine?.id ?? crypto.randomUUID(), revision: routine?.revision ?? 0, config });
  };

  const patch = (changes: Partial<RoutineInput>) => {
    setEditor(previous => previous ? { ...previous, config: { ...previous.config, ...changes } } : null);
    setFormError(null); api.clearFeedback();
  };

  const normalized = (): RoutineInput | null => {
    if (!editor) return null;
    try { const config = normalizeRoutineInput(editor.config); setFormError(null); return config; }
    catch (error) { setFormError(error instanceof Error ? error.message : 'Vérifiez les réglages de la routine.'); return null; }
  };

  const preview = () => {
    const config = normalized();
    if (!config) return;
    setEditor(previous => previous ? { ...previous, config } : null);
    run(() => api.preview(config));
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const config = normalized();
    if (!editor || !config) return;
    run(async () => {
      const saved = await api.save(editor.id, editor.revision, config);
      setEditor({ id: saved.id, revision: saved.revision, config: saved.config });
    });
  };

  const config = editor?.config;
  const matchingPreview = config && api.previewResult?.fingerprint === routineFingerprint(config) ? api.previewResult : null;
  const callUnavailable = !!config?.channels.includes('call') && (!caps?.calls || !caps?.verifiedPhone);
  const channelsUnavailable = callUnavailable || (!!config?.channels.includes('email') && !caps?.email)
    || (!!config?.channels.includes('push') && !caps?.push);
  const canActivate = caps?.routines && !channelsUnavailable;

  if (!api.ownerId) return <Card className="glass-effect"><CardHeader>
    <CardTitle>Appels et routines IAO</CardTitle><CardDescription>Connectez-vous pour retrouver vos routines personnelles.</CardDescription>
  </CardHeader></Card>;

  return <section aria-labelledby={field('heading')} className="space-y-4">
    <Card className="glass-effect">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <CardTitle id={field('heading')} className="flex items-center gap-2"><CalendarClock aria-hidden="true" className="h-5 w-5" />Appels et routines IAO</CardTitle>
            <CardDescription>Votre bilan au bon moment, sur les canaux que vous choisissez.</CardDescription>
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label="Actualiser les routines" disabled={api.refreshing || busy} onClick={() => run(api.refresh)}>
            <RefreshCw aria-hidden="true" className={`h-4 w-4 ${api.refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {api.loading ? <div role="status" aria-label="Chargement des routines" className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-12 w-full" /></div>
          : api.error ? <div role="alert" className="rounded-lg border border-destructive/40 p-4 space-y-3"><p>{api.error}</p>
            <Button type="button" variant="outline" disabled={api.refreshing} onClick={() => run(api.refresh)}>Réessayer le chargement</Button></div>
            : <>
              {!caps?.routines && <p role="status" className="rounded-lg bg-muted p-3 text-sm">L’envoi des routines n’est pas disponible actuellement. Vos réglages peuvent être préparés en pause.</p>}
              <div className="rounded-lg border p-3 text-sm space-y-1">
                <p className="font-medium flex items-center gap-2"><Phone aria-hidden="true" className="h-4 w-4" />
                  {caps?.calls && caps.verifiedPhone ? `Appels disponibles vers ${caps.verifiedPhone}` : 'Appels à configurer'}</p>
                {(!caps?.calls || !caps.verifiedPhone) && <p className="text-muted-foreground">{caps?.phoneBlockedReason || 'Un numéro vérifié et un service téléphonique actif sont nécessaires.'}</p>}
              </div>
              {api.data?.routines.length === 0 ? <p className="text-sm text-muted-foreground">Aucune routine enregistrée. Choisissez un point de départ.</p>
                : <ul className="space-y-3" aria-label="Routines enregistrées">{api.data?.routines.map(routine => {
                  const processing = api.data?.history.some(item => item.routineId === routine.id && ['pending', 'processing', 'unknown'].includes(item.status));
                  const uncertain = api.uncertainRuns.includes(routine.id);
                  const canRun = caps?.routines && routine.config.enabled && (!routine.config.channels.includes('call') || caps.calls);
                  return <li key={routine.id} className="rounded-lg border p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2"><div className="min-w-0">
                      <h3 className="font-medium break-words">{routine.config.name}</h3>
                      <p className="text-sm text-muted-foreground">{describeSchedule(routine.config.schedule)}</p>
                    </div><span className="shrink-0 text-xs rounded-full bg-muted px-2 py-1">{routine.config.enabled ? 'Active' : 'En pause'}</span></div>
                    <p className="text-sm text-muted-foreground">{routine.config.channels.map(channel => CHANNELS.find(item => item.value === channel)?.label).join(' · ')}</p>
                    {routine.config.pausedUntil && <p className="text-sm">Suspendue jusqu’au {formatDate(routine.config.pausedUntil, routine.config.schedule.timezone)}</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => edit(routine)}><Settings2 aria-hidden="true" className="h-4 w-4 mr-2" />Modifier<span className="sr-only"> {routine.config.name}</span></Button>
                      {routine.config.enabled && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => run(() => api.pause(routine))}><Pause aria-hidden="true" className="h-4 w-4 mr-2" />Mettre en pause<span className="sr-only"> {routine.config.name}</span></Button>}
                      <Button type="button" size="sm" variant="secondary" disabled={busy || !canRun || (!!processing && !uncertain)} onClick={() => run(() => api.runNow(routine))}>
                        {uncertain ? 'Vérifier la demande' : routine.config.channels.includes('call') ? 'M’appeler maintenant' : 'Recevoir maintenant'}<span className="sr-only"> — {routine.config.name}</span>
                      </Button>
                    </div>
                    {processing && !uncertain && <p className="text-xs text-muted-foreground">Un envoi attend encore son résultat. Consultez l’historique avant une nouvelle demande.</p>}
                  </li>;
                })}</ul>}
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={busy} onClick={() => edit()}><Plus aria-hidden="true" className="h-4 w-4 mr-2" />Créer une routine</Button>
                {!!api.data?.routines.some(routine => routine.config.enabled) && <Button type="button" variant="outline" disabled={busy} onClick={() => run(api.pauseAll)}>Tout mettre en pause</Button>}
              </div>
              {!editor && <div className="flex flex-wrap gap-2" aria-label="Exemples de routines">
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => edit(undefined, 'morning')}>Bilan du matin</Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => edit(undefined, 'evening')}>Fin de journée</Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => edit(undefined, 'decision')}>Besoin d’une décision</Button>
              </div>}
            </>}
        {api.operationError && <div role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm space-y-2"><p>{api.operationError}</p>
          {api.uncertain && <p>Aucun nouvel envoi n’est lancé automatiquement.</p>}
        </div>}
        {api.notice && <p role="status" className="rounded-lg bg-muted p-3 text-sm flex items-start gap-2"><Check aria-hidden="true" className="h-4 w-4 shrink-0 mt-0.5" />{api.notice}</p>}
      </CardContent>
    </Card>

    {editor && config && <Card className="glass-effect">
      <CardHeader><div className="flex items-center justify-between gap-3"><CardTitle className="text-lg">{editor.revision ? 'Modifier la routine' : 'Nouvelle routine'}</CardTitle>
        <Button type="button" variant="ghost" size="icon" aria-label="Fermer l’éditeur de routine" disabled={busy} onClick={() => { setEditor(null); setFormError(null); api.clearFeedback(); }}><X aria-hidden="true" className="h-4 w-4" /></Button></div>
        <CardDescription>Un seul bilan, adapté à vos canaux. Les réglages restent modifiables.</CardDescription></CardHeader>
      <CardContent><form onSubmit={save} className="space-y-6" aria-label="Réglages de la routine">
        <fieldset disabled={busy || unavailable} className="space-y-6 min-w-0">
          <legend className="sr-only">Personnaliser votre routine</legend>
          <div className="space-y-2"><Label htmlFor={field('name')}>Nom de la routine</Label><Input id={field('name')} value={config.name} maxLength={100} required onChange={event => patch({ name: event.target.value })} /></div>
          <div className="space-y-2"><Label htmlFor={field('instruction')}>Ce que vous souhaitez savoir</Label>
            <Textarea id={field('instruction')} value={config.instruction} required maxLength={4000} rows={3} onChange={event => patch({ instruction: event.target.value })} aria-describedby={field('sources')} />
            <p id={field('sources')} className="text-xs text-muted-foreground">Le bilan s’appuie sur l’activité KARTA des agents inclus et leurs résumés disponibles.</p></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor={field('kind')}>Quand ?</Label><select id={field('kind')} className={selectClass} value={config.schedule.kind} onChange={event => {
              const kind = event.target.value as RoutineSchedule['kind']; const zone = config.schedule.timezone;
              patch({ schedule: kind === 'daily' ? { kind, time: 'time' in config.schedule ? config.schedule.time : '08:30', timezone: zone }
                : kind === 'weekly' ? { kind, time: 'time' in config.schedule ? config.schedule.time : '08:30', timezone: zone, days: [1, 2, 3, 4, 5] }
                  : kind === 'once' ? { kind, at: new Date(Date.now() + 3_600_000).toISOString(), timezone: zone }
                    : { kind, event: 'completed', timezone: zone } });
            }}><option value="daily">Tous les jours</option><option value="weekly">Certains jours</option><option value="once">Une seule fois</option><option value="event">Lors d’un événement</option></select></div>
            <div className="space-y-2"><Label htmlFor={field('timezone')}>Fuseau horaire</Label><Input id={field('timezone')} value={config.schedule.timezone} list={field('timezones')} placeholder="Europe/Paris" required maxLength={100} onChange={event => patch({ schedule: { ...config.schedule, timezone: event.target.value } })} />
              <datalist id={field('timezones')}><option value="Europe/Paris" /><option value="Europe/Zurich" /><option value="Europe/London" /><option value="America/Montreal" /><option value="UTC" /></datalist></div>
          </div>
          {('time' in config.schedule) && <div className="space-y-2"><Label htmlFor={field('time')}>Heure locale</Label><Input id={field('time')} type="time" value={config.schedule.time} required onChange={event => patch({ schedule: { ...config.schedule, time: event.target.value } as RoutineSchedule })} className="max-w-48" /></div>}
          {config.schedule.kind === 'weekly' && <fieldset className="space-y-2"><legend className="text-sm font-medium mb-2">Jours de la semaine</legend><div className="flex flex-wrap gap-2">{DAYS.map(day => <Button key={day.value} type="button" variant={config.schedule.kind === 'weekly' && config.schedule.days.includes(day.value) ? 'default' : 'outline'} size="sm" aria-pressed={config.schedule.kind === 'weekly' && config.schedule.days.includes(day.value)} aria-label={day.name} onClick={() => {
            if (config.schedule.kind !== 'weekly') return;
            patch({ schedule: { ...config.schedule, days: config.schedule.days.includes(day.value) ? config.schedule.days.filter(value => value !== day.value) : [...config.schedule.days, day.value].sort((a, b) => a - b) } });
          }}>{day.short}</Button>)}</div></fieldset>}
          {config.schedule.kind === 'once' && <div className="space-y-2"><Label htmlFor={field('once')}>Date et heure dans le fuseau choisi</Label><Input id={field('once')} type="datetime-local" required value={wallValue(config.schedule.at, config.schedule.timezone)} onChange={event => {
            try { const at = routineInstantFromLocal(event.target.value, config.schedule.timezone); if (!at) throw new Error(); patch({ schedule: { kind: 'once', at, timezone: config.schedule.timezone } }); }
            catch { setFormError('Choisissez une date valide dans le fuseau indiqué.'); }
          }} /></div>}
          {config.schedule.kind === 'event' && <div className="space-y-2"><Label htmlFor={field('event')}>Événement déclencheur</Label><select id={field('event')} className={selectClass} value={config.schedule.event} onChange={event => patch({ schedule: { kind: 'event', event: event.target.value as 'completed' | 'blocked' | 'decision', timezone: config.schedule.timezone } })}><option value="completed">Un travail est terminé</option><option value="blocked">Un travail est bloqué</option><option value="decision">Une décision est nécessaire</option></select></div>}

          <fieldset className="space-y-3"><legend className="text-sm font-medium mb-3">Comment recevoir le bilan ?</legend>
            <div className="grid gap-3 sm:grid-cols-2">{CHANNELS.map(channel => <label key={channel.value} className="flex items-center gap-3 rounded-lg border p-3 cursor-pointer" htmlFor={field(channel.value)}>
              <Checkbox id={field(channel.value)} checked={config.channels.includes(channel.value)} onCheckedChange={checked => patch({ channels: checked === true ? [...config.channels, channel.value] : config.channels.filter(value => value !== channel.value) })} />
              <channel.icon aria-hidden="true" className="h-4 w-4 shrink-0" /><span className="text-sm">{channel.label}</span>
            </label>)}</div>
            <p className="text-xs text-muted-foreground">Vous pouvez combiner l’appel, le message et la notification. Un e-mail reste une option distincte.</p>
            <Label htmlFor={field('mode')}>Si plusieurs canaux sont sélectionnés</Label><select id={field('mode')} className={selectClass} value={config.deliveryMode} onChange={event => patch({ deliveryMode: event.target.value as RoutineInput['deliveryMode'] })}><option value="parallel">Utiliser tous les canaux sélectionnés</option><option value="fallback">Essayer dans l’ordre, puis passer au suivant si nécessaire</option></select>
            {config.deliveryMode === 'fallback' && <div className="rounded-lg bg-muted p-3 space-y-2"><p className="text-xs font-medium">Ordre des tentatives</p>{config.channels.map((channel, index) => <div key={channel} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{index + 1}. {CHANNELS.find(item => item.value === channel)?.label}</span><Button type="button" size="sm" variant="ghost" disabled={index === 0} aria-label={`Faire passer ${CHANNELS.find(item => item.value === channel)?.label} plus tôt`} onClick={() => {
              const channels = [...config.channels]; [channels[index - 1], channels[index]] = [channels[index], channels[index - 1]]; patch({ channels });
            }}>Monter</Button></div>)}</div>}
            {channelsUnavailable && <p role="status" className="text-sm rounded-lg bg-muted p-3">Un canal sélectionné n’est pas disponible. Retirez-le pour activer la routine, ou enregistrez vos réglages en pause.</p>}
            {config.channels.includes('call') && <p className="text-xs text-muted-foreground">Les instructions données au téléphone sont conservées pour confirmation dans IAO. Elles ne déclenchent pas automatiquement de nouvelles actions.</p>}
          </fieldset>

          <div className="space-y-2"><Label htmlFor={field('length')}>Longueur du bilan</Label><select id={field('length')} className={selectClass} value={config.length} onChange={event => patch({ length: event.target.value as RoutineInput['length'] })}><option value="express">Express — l’essentiel</option><option value="standard">Standard — résultats et prochaines étapes</option><option value="detailed">Détaillé — davantage de contexte</option></select></div>
          <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">Agents inclus</summary><div className="mt-3 space-y-3"><p className="text-xs text-muted-foreground">Sans sélection, le bilan prend en compte vos agents disponibles.</p>
            {[...new Set([...(caps?.agents.map(agent => agent.type) ?? []), ...config.agentTypes])].map(type => <label key={type} className="flex items-center gap-3 text-sm" htmlFor={field(`agent-${type}`)}><Checkbox id={field(`agent-${type}`)} checked={config.agentTypes.includes(type)} onCheckedChange={checked => patch({ agentTypes: checked === true ? [...config.agentTypes, type] : config.agentTypes.filter(value => value !== type) })} />{caps?.agents.find(agent => agent.type === type)?.name ?? type}</label>)}
          </div></details>
          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between gap-3"><Label htmlFor={field('new-only')}>Me prévenir seulement s’il y a du nouveau</Label><Switch id={field('new-only')} checked={config.onlyIfNew} onCheckedChange={onlyIfNew => patch({ onlyIfNew })} /></div>
            <div className="flex items-center justify-between gap-3"><Label htmlFor={field('quiet')}>Respecter des heures calmes</Label><Switch id={field('quiet')} checked={config.quietHours !== null} onCheckedChange={enabled => patch({ quietHours: enabled ? { start: '22:00', end: '08:00' } : null })} /></div>
            {config.quietHours && <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor={field('quiet-start')}>À partir de</Label><Input id={field('quiet-start')} type="time" value={config.quietHours.start} onChange={event => patch({ quietHours: { ...config.quietHours!, start: event.target.value } })} required /></div><div className="space-y-2"><Label htmlFor={field('quiet-end')}>Jusqu’à</Label><Input id={field('quiet-end')} type="time" value={config.quietHours.end} onChange={event => patch({ quietHours: { ...config.quietHours!, end: event.target.value } })} required /></div></div>}
            <div className="space-y-2"><Label htmlFor={field('pause-until')}>Suspendre jusqu’à une date — facultatif</Label><Input id={field('pause-until')} type="datetime-local" value={wallValue(config.pausedUntil, config.schedule.timezone)} onChange={event => {
              if (!event.target.value) { patch({ pausedUntil: null }); return; }
              try { const pausedUntil = routineInstantFromLocal(event.target.value, config.schedule.timezone); if (!pausedUntil) throw new Error(); patch({ pausedUntil }); }
              catch { setFormError('La date de reprise est invalide.'); }
            }} /><p className="text-xs text-muted-foreground">Heure du fuseau {config.schedule.timezone}. Aucun rattrapage en masse après la pause.</p></div>
          </div>
          {config.channels.includes('call') && <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={field('duration')}>Durée maximale d’un appel (minutes)</Label><Input id={field('duration')} type="number" min={1} max={10} step={1} value={config.maxCallMinutes} required onChange={event => patch({ maxCallMinutes: Number(event.target.value) })} /></div><div className="space-y-2"><Label htmlFor={field('budget')}>Plafond mensuel d’appels (minutes)</Label><Input id={field('budget')} type="number" min={0} max={3000} step={1} value={config.monthlyCallMinutes} required onChange={event => patch({ monthlyCallMinutes: Number(event.target.value) })} /><p className="text-xs text-muted-foreground">Appels de votre compte, sur le mois UTC. Ce plafond de minutes ne fixe pas leur prix.</p></div></div>}
          <div className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3"><div className="space-y-1"><Label htmlFor={field('enabled')}>Activer après l’enregistrement</Label><p className="text-xs text-muted-foreground">Désactivez cette option pour préparer la routine en pause.</p></div><Switch id={field('enabled')} checked={config.enabled} onCheckedChange={enabled => patch({ enabled })} /></div>
        </fieldset>
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <div className="rounded-lg border p-4 space-y-3" aria-live="polite"><h4 className="text-sm font-medium">Vérification avant activation</h4>
          {matchingPreview ? config.schedule.kind === 'event' ? <p className="text-sm">Le bilan sera préparé après l’événement choisi, en respectant vos pauses et heures calmes.</p>
            : matchingPreview.occurrences.length ? <ol className="space-y-1 text-sm list-decimal pl-5">{matchingPreview.occurrences.map(at => <li key={at}>{formatDate(at, config.schedule.timezone)}</li>)}</ol>
              : <p className="text-sm">Aucune prochaine occurrence dans la période vérifiée.</p>
            : <p className="text-sm text-muted-foreground">Vérifiez l’horaire et le fuseau. L’aperçu sera actualisé par le service.</p>}
          <Button type="button" variant="outline" disabled={busy || unavailable} onClick={preview}>{api.busy === 'preview' ? 'Vérification…' : 'Vérifier les prochaines occurrences'}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={busy || unavailable || (config.enabled && (!matchingPreview || !canActivate || (config.schedule.kind !== 'event' && matchingPreview.occurrences.length === 0)))}>{api.busy === 'save' ? 'Enregistrement…' : config.enabled ? 'Enregistrer et activer' : 'Enregistrer en pause'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => { setEditor(null); api.clearFeedback(); }}>Fermer</Button></div>
      </form></CardContent>
    </Card>}

    {!!api.data?.history.length && <Card className="glass-effect"><CardHeader><CardTitle className="text-lg">Derniers envois</CardTitle><CardDescription>Une acceptation par le service ne confirme pas que le bilan a été entendu ou lu.</CardDescription></CardHeader><CardContent><ul className="space-y-4">{api.data.history.map(item => <li key={item.id} className="rounded-lg border p-3 space-y-2">
      <div className="flex flex-wrap justify-between gap-2 text-sm"><p className="font-medium">{api.data?.routines.find(routine => routine.id === item.routineId)?.config.name ?? 'Bilan IAO'}</p><span>{STATUS[item.status] ?? 'État à vérifier'}</span></div>
      <p className="text-xs text-muted-foreground">{formatDate(item.scheduledAt)}</p>
      {item.report && <details><summary className="cursor-pointer text-sm">{item.report.title}</summary><p className="text-sm whitespace-pre-wrap mt-2 break-words">{item.report.body}</p></details>}
      {!!item.deliveries.length && <ul className="text-xs text-muted-foreground space-y-1" aria-label="État par canal">{item.deliveries.map(delivery => <li key={delivery.channel}>{CHANNELS.find(channel => channel.value === delivery.channel)?.label} : {STATUS[delivery.status] ?? 'À vérifier'}</li>)}</ul>}
      {['pending', 'processing', 'unknown'].includes(item.status) && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => run(() => api.cancel(item.id))}>Annuler les envois en attente</Button>}
    </li>)}</ul></CardContent></Card>}
    {!!api.data?.commands.length && <Card className="glass-effect"><CardHeader><CardTitle className="text-lg">Instructions reçues au téléphone</CardTitle><CardDescription>Les demandes en attente ne sont pas exécutées automatiquement.</CardDescription></CardHeader><CardContent><ul className="space-y-3">{api.data.commands.map(command => <li key={command.id} className="rounded-lg border p-3"><p className="text-sm whitespace-pre-wrap break-words">{command.instruction}</p><p className="text-xs text-muted-foreground mt-2">{command.status === 'pending_confirmation' ? 'À confirmer dans IAO' : command.status === 'submitted' ? 'Demande transmise' : 'Demande annulée'} · {formatDate(command.createdAt)}</p></li>)}</ul></CardContent></Card>}
  </section>;
}
