import { useEffect, useRef, useState } from 'react';
import { pendulumUrl, readPendulumReceipt, scienceHandoffUrl, type ScienceHandoff, type PendulumInputs, type PendulumReceipt } from '@/lib/iao-science-entry';

const format = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 4, maximumSignificantDigits: 6 });

export function ScienceHandoffLink({ target }: { target: ScienceHandoff }) {
  const url = scienceHandoffUrl(import.meta.env.VITE_PURAMA_ONE_ORIGIN, target);
  if (!url) return <p role="status">L’adresse de PURAMA ONE reste à configurer.</p>;
  return <a href={url.href} target="_blank" rel="noopener noreferrer" className="mt-2 block underline">
    {target === 'correlation' ? 'Ouvrir l’atelier de corrélation' : 'Préparer le protocole'}
  </a>;
}

export function ScienceReceipt({ receipt }: { receipt: PendulumReceipt }) {
  return <div className="mt-2 space-y-1 text-sm">
    <p>Période simulée : <strong>{format.format(receipt.periodSeconds)} s</strong>.</p>
    <p>{receipt.measuredPeriodSeconds === null ? 'Aucune période mesurée renseignée.' :
      'Période issue de votre mesure : ' + format.format(receipt.measuredPeriodSeconds) + ' s.'}</p>
    <p className="break-words text-xs text-muted-foreground">Modèle {receipt.modelId} · {receipt.trials.toLocaleString('fr-FR')} tirage(s).</p>
  </div>;
}

export function IaoScienceTrial({ kind = 'pendule', inputs = {}, onReceipt }: {
  kind?: 'pendule' | 'correlation'; inputs?: PendulumInputs; onReceipt?: (receipt: PendulumReceipt | null) => void;
}) {
  const origin = import.meta.env.VITE_PURAMA_ONE_ORIGIN;
  const href = (kind === 'correlation' ? scienceHandoffUrl(origin, 'correlation') : pendulumUrl(origin, inputs))?.href;
  const handshake = kind === 'pendule' ? 'purama:pendulum:' : 'purama:correlation:';
  const notify = useRef(onReceipt);
  useEffect(() => { notify.current = onReceipt; }, [onReceipt]);
  const [localReceipt, setLocalReceipt] = useState<PendulumReceipt | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [canLoad, setCanLoad] = useState(online);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unconfirmed'>('loading');

  useEffect(() => {
    const update = () => {
      const connected = navigator.onLine !== false;
      setOnline(connected);
      if (connected) setCanLoad(true);
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);

  useEffect(() => {
    if (!href || !canLoad) return;
    const origin = new URL(href).origin;
    setStatus('loading');
    const probe = () => frame.current?.contentWindow?.postMessage(handshake + 'probe:v1', origin);
    const interval = window.setInterval(probe, 500);
    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
      setStatus('unconfirmed');
    }, 12000);
    const ready = (event: MessageEvent) => {
      if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow ||
        event.origin !== origin) return;
      const receipt = kind === 'pendule' ? readPendulumReceipt(event.data) : null;
      const cleared = kind === 'pendule' && event.data?.type === 'purama:pendulum:result:v1' && event.data.report === null;
      if (!receipt && !cleared && event.data !== handshake + 'ready:v1') return;
      if (receipt || cleared) {
        if (notify.current) notify.current(receipt);
        else setLocalReceipt(receipt);
      }
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      setStatus('ready');
    };
    window.addEventListener('message', ready);
    probe();
    return () => {
      window.removeEventListener('message', ready);
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [attempt, href, canLoad, handshake, kind]);

  if (!href) return <p role="status">L’adresse de l’atelier PURAMA ONE reste à configurer pour ouvrir cette simulation.</p>;
  if (!canLoad) return <p role="status">Connexion nécessaire pour ouvrir l’atelier. Les paramètres de votre demande sont conservés ici.</p>;
  return <div className="mt-2 space-y-2">
    {localReceipt && <ScienceReceipt receipt={localReceipt} />}
    {!online && <p role="status">Connexion interrompue. Les contenus déjà chargés restent affichés.</p>}
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{kind === 'correlation' ? 'Ouvrir l’atelier de corrélation en pleine page' : 'Ouvrir l’atelier en pleine page'}</a>
    {status === 'loading' && <p role="status">Connexion à l’atelier…</p>}
    {status === 'unconfirmed' && <p role="status">L’atelier intégré ne répond pas. Utilisez la pleine page ou{' '}
      <button type="button" className="underline" onClick={() => setAttempt(n => n + 1)}>réessayez</button>.</p>}
    <iframe key={href + ':' + attempt} ref={frame} title={kind === 'pendule' ? 'Simulation 3D du pendule simple' : 'Comparaison de deux séries numériques'} src={href}
      className="block h-[min(65dvh,32rem)] min-h-64 w-full rounded-lg border border-border"
      allow="xr-spatial-tracking 'src'; fullscreen 'src'" allowFullScreen referrerPolicy="no-referrer"
      sandbox="allow-same-origin allow-scripts allow-downloads allow-forms allow-popups allow-popups-to-escape-sandbox" />
  </div>;
}
