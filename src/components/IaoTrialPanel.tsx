import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, CalendarDays, Link2, Scale, Video } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { IaoBasketTrial } from './IaoBasketTrial';
import { IaoMediaTrial } from './IaoMediaTrial';
import { IaoWorkshopTrial } from './IaoWorkshopTrial';
import { sharedTrial, type TrialEntry, type TrialKind } from '@/lib/iao-trial-entry';

const methods = [
  { id: 'panier', label: 'Composer un panier', detail: 'Quantité exacte, prix et stock disponible.', icon: Scale },
  { id: 'media', label: 'Comparer des médias', detail: 'Poids, dimensions et aperçu sur vos fichiers.', icon: Video },
  { id: 'atelier', label: 'Préparer un atelier', detail: 'Frais, places et seuil de rentabilité.', icon: CalendarDays },
] as const;

type TrialPanelProps = { entry: TrialEntry } & (
  | { standalone: true; onClose?: never }
  | { standalone?: false; onClose: () => void }
);

export default function IaoTrialPanel({ entry, onClose, standalone = false }: TrialPanelProps) {
  const [kind, setKind] = useState<TrialKind | null>(entry.kind);
  const [visited, setVisited] = useState<TrialKind[]>(entry.kind ? [entry.kind] : []);
  const heading = useRef<HTMLHeadingElement>(null);
  const panels = useRef<HTMLDivElement>(null);
  const selected = methods.find(method => method.id === kind);
  const show = useCallback((next: TrialKind | null) => {
    if (next) setVisited(previous => previous.includes(next) ? previous : [...previous, next]);
    setKind(next);
  }, []);

  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [kind]);
  useEffect(() => {
    // Keep each trial's files and position while stopping playback outside the active panel.
    panels.current?.querySelectorAll<HTMLMediaElement>('[hidden] audio, [hidden] video')
      .forEach(media => media.pause());
  }, [kind]);
  useEffect(() => {
    if (!standalone) return;
    const showFromLocation = () => show(sharedTrial(window.location.hash));
    window.addEventListener('hashchange', showFromLocation);
    return () => window.removeEventListener('hashchange', showFromLocation);
  }, [show, standalone]);

  function choose(next: TrialKind | null) {
    if (standalone) {
      const page = new URL(window.location.pathname, window.location.origin);
      if (next) page.hash = 'essai/' + next;
      window.history.pushState(null, '', page.href);
    }
    show(next);
  }

  const Title = standalone ? 'h1' : DialogTitle;
  const Description = standalone ? 'p' : DialogDescription;
  const content = <>
      <header className="shrink-0 border-b border-border px-5 py-4 pr-12 sm:px-6">
        {kind && <button type="button" onClick={() => choose(null)} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft size={15} aria-hidden="true" />Tous les essais
        </button>}
        <Title ref={heading} tabIndex={-1} className="text-xl focus:outline-none">{selected?.label ?? 'Essaie-le pour moi'}</Title>
        <Description className="mt-1 text-sm text-muted-foreground">{selected?.detail ?? 'Choisissez ce que vous voulez vérifier.'}</Description>
      </header>
      <div ref={panels} className="min-h-0 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
        {!kind && <div className="grid gap-2">
          {methods.map(({ id, label, detail, icon: Icon }) => <button key={id} type="button" onClick={() => choose(id)}
            className="flex min-h-16 items-center gap-3 rounded-xl border border-border p-3 text-left hover:border-primary focus-visible:ring-2 focus-visible:ring-ring">
            <Icon size={21} className="shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1"><span className="block font-medium">{label}</span><span className="text-sm text-muted-foreground">{detail}</span></span>
            <ArrowUpRight size={17} aria-hidden="true" />
          </button>)}
        </div>}
        {visited.map(id => <div key={id} hidden={id !== kind}>
          {id === 'panier' && <IaoBasketTrial initialUnits={entry.initialUnits} initialBudgetCents={entry.initialBudgetCents} />}
          {id === 'media' && <IaoMediaTrial showCupExample={standalone &&
            /^\/pura-live\/essais(?:\/(?:index\.html)?)?$/.test(window.location.pathname)} />}
          {id === 'atelier' && <IaoWorkshopTrial />}
        </div>)}
        {kind && <ShareMethod key={kind} kind={kind} standalone={standalone} />}
      </div>
  </>;

  if (standalone) return <section className="trial-sheet">{content}</section>;
  return <Dialog open onOpenChange={open => { if (!open) onClose?.(); }}>
    <DialogContent className="flex max-h-[92dvh] w-[min(96vw,42rem)] max-w-2xl flex-col gap-0 overflow-hidden rounded-2xl p-0"
      onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus(); }}>
      {content}
    </DialogContent>
  </Dialog>;
}

function ShareMethod({ kind, standalone }: { kind: TrialKind; standalone: boolean }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const url = new URL(standalone ? '/pura-live/essais/' : '/', window.location.origin);
  url.hash = 'essai/' + kind;
  async function copy() {
    try {
      await navigator.clipboard.writeText(url.href);
      setCopyState('copied');
    } catch {
      setCopyState('manual');
    }
  }
  return <footer className="mt-5 border-t border-border pt-3">
    <Button type="button" variant="outline" size="sm" onClick={copy}><Link2 aria-hidden="true" />Copier le lien de la méthode</Button>
    <p className="mt-2 text-xs text-muted-foreground" role="status">{copyState === 'copied' ? 'Lien copié. Chacun utilise ses propres données.' : 'Le lien ouvre cet essai avec ses réglages de départ.'}</p>
    {copyState === 'manual' && <label className="mt-2 block text-sm">Lien à copier
      <input className="mt-1 w-full rounded-md border border-input bg-background p-2" readOnly value={url.href} onFocus={e => e.target.select()} />
    </label>}
  </footer>;
}
