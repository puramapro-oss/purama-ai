import { useEffect, useId, useMemo, useRef, useState } from 'react';
import mediaToolUrl from '../../scripts/iao-media-variants.py?url';
import {
  DEFAULT_MEDIA_CRITERIA, MEDIA_DURATION_TOLERANCE_SECONDS, evaluateMediaTrial, inspectMediaFile,
  type MediaSample,
} from '@/lib/iao-media-trial';

const percent = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat('fr-FR');
const fieldClass = 'block w-full min-w-0 rounded-md border border-input bg-background px-2 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';
const buttonClass = 'rounded-md border border-input px-3 py-2 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50';
const resultLabels = { pass: 'Critères atteints', fail: 'Critères non atteints', unverified: 'Mesure incomplète' };

function fileSize(bytes: number) {
  return bytes >= 1_000_000 ? `${percent.format(bytes / 1_000_000)} Mo`
    : bytes >= 1_000 ? `${percent.format(bytes / 1_000)} ko` : `${integer.format(bytes)} octets`;
}

function useLocalUrl(file: File | null) {
  const [entry, setEntry] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(file);
    setEntry({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return entry?.file === file ? entry?.url : undefined;
}

function MediaPreview({ file, sample, label, canDownload = false }: {
  file: File; sample: MediaSample | null; label: string; canDownload?: boolean;
}) {
  const url = useLocalUrl(file);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <figure className="min-w-0 space-y-1">
    <figcaption className="text-xs">
      <strong className="block">{label}</strong>
      <span className="break-all">{file.name}</span>
    </figcaption>
    {url && sample?.width && sample.height && failedUrl !== url && (
      sample.kind === 'image'
        ? <img src={url} alt={`Aperçu de ${file.name}`} onError={() => setFailedUrl(url)} className="h-auto max-h-48 w-full rounded-md bg-black/10 object-contain" />
        : sample.kind === 'video' && <video key={url} src={url} controls playsInline preload="metadata"
          aria-label={`${label} – ${file.name}`} onError={() => setFailedUrl(url)} className="max-h-48 w-full rounded-md bg-black" />
    )}
    {url && failedUrl === url && <p className="text-xs">L’aperçu ne s’ouvre pas dans ce navigateur.</p>}
    <p className="text-xs text-muted-foreground">
      {fileSize(file.size)}{sample?.width && sample.height ? ` · ${sample.width} × ${sample.height} px` : ''}
      {sample?.durationSeconds != null && ` · ${percent.format(sample.durationSeconds)} s`}
    </p>
    {canDownload && url && <a href={url} download={file.name} className="inline-block py-1 text-xs font-medium text-primary underline">Télécharger la variante</a>}
  </figure>;
}

async function encodeStillImage(file: File, sample: MediaSample, signal: AbortSignal) {
  if (typeof createImageBitmap !== 'function') throw new Error('Ce navigateur ne prend pas en charge la création de variantes locales.');
  if (!sample.width || !sample.height || sample.width * sample.height > 16_777_216) {
    throw new Error('La création locale est disponible pour les images jusqu’à 16,7 millions de pixels.');
  }
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  try {
    signal.throwIfAborted();
    if (bitmap.width * bitmap.height > 16_777_216) throw new Error('Cette image est trop grande pour la création locale.');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Le navigateur n’a pas pu ouvrir la surface de dessin.');
    context.drawImage(bitmap, 0, 0);
    const jpeg = file.type === 'image/jpeg' || (!file.type && /\.jpe?g$/i.test(file.name));
    const mime = jpeg ? 'image/jpeg' : 'image/webp';
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, 0.76));
    signal.throwIfAborted();
    if (!blob || blob.type !== mime) throw new Error('Ce navigateur ne peut pas encoder cette image dans le format demandé.');
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-iao-76.${jpeg ? 'jpg' : 'webp'}`, { type: mime });
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

const cupExamplePaths = [
  '/pura-live/tasse-avant-apres.mp4',
  '/pura-live/essais/exemple/qualite.mp4',
  '/pura-live/essais/exemple/legere.mp4',
];

export function IaoMediaTrial({ showCupExample = false }: { showCupExample?: boolean } = {}) {
  const id = useId();
  const [original, setOriginal] = useState<File | null>(null);
  const [variants, setVariants] = useState<File[]>([]);
  const [selected, setSelected] = useState(0);
  const [reduction, setReduction] = useState(DEFAULT_MEDIA_CRITERIA.minReductionPercent);
  const [encoded, setEncoded] = useState<File | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [error, setError] = useState('');
  const encoder = useRef<AbortController | null>(null);
  const exampleRequest = useRef<AbortController | null>(null);
  const [exampleStatus, setExampleStatus] = useState<'idle' | 'loading' | 'ready'>('idle');
  const files = useMemo(() => original ? [original, ...variants] : [], [original, variants]);
  const [measurements, setMeasurements] = useState<{ files: File[]; samples: MediaSample[] } | null>(null);
  const samples = measurements?.files === files ? measurements.samples : null;
  const baseline = samples?.[0] ?? null;
  const result = samples && variants.length ? evaluateMediaTrial(baseline, samples.slice(1), { minReductionPercent: reduction }) : null;

  useEffect(() => {
    if (!files.length) return;
    const controller = new AbortController();
    async function measure() {
      const measured: MediaSample[] = [];
      for (const file of files) {
        if (controller.signal.aborted) return;
        try {
          measured.push(await inspectMediaFile(file, controller.signal));
        } catch {
          if (controller.signal.aborted) return;
          measured.push({ name: file.name, bytes: file.size, width: null, height: null, durationSeconds: null, kind: 'unknown' });
        }
      }
      if (!controller.signal.aborted) setMeasurements({ files, samples: measured });
    }
    void measure();
    return () => controller.abort();
  }, [files]);

  useEffect(() => () => {
    encoder.current?.abort();
    exampleRequest.current?.abort();
  }, []);

  function cancelExample() {
    exampleRequest.current?.abort();
    exampleRequest.current = null;
    setExampleStatus('idle');
  }

  function chooseOriginal(file: File | null, newVariants: File[] = []) {
    cancelExample();
    encoder.current?.abort();
    setOriginal(file);
    setVariants(newVariants);
    setSelected(0);
    setEncoded(null);
    setEncoding(false);
    setError('');
    setMeasurements(null);
  }

  async function loadCupExample() {
    if (!showCupExample || exampleRequest.current) return;
    const controller = new AbortController();
    exampleRequest.current = controller;
    setError('');
    setExampleStatus('loading');
    try {
      const files = await Promise.all(cupExamplePaths.map(async path => {
        const response = await fetch(path, { signal: controller.signal, mode: 'same-origin', redirect: 'error' });
        if (!response.ok) throw new Error();
        const blob = await response.blob();
        if (await blob.slice(4, 8).text() !== 'ftyp') throw new Error();
        return new File([blob], path.substring(path.lastIndexOf('/') + 1), { type: 'video/mp4' });
      }));
      if (controller.signal.aborted) return;
      chooseOriginal(files[0], files.slice(1));
      setExampleStatus('ready');
    } catch {
      if (controller.signal.aborted) return;
      cancelExample();
      setError('L’exemple vidéo n’a pas pu être chargé. Réessayez ou choisissez vos propres fichiers.');
    }
  }

  async function createVariant() {
    if (!original || !baseline || encoded || (encoder.current && !encoder.current.signal.aborted)) return;
    const controller = new AbortController();
    encoder.current = controller;
    setEncoding(true);
    setError('');
    try {
      const file = await encodeStillImage(original, baseline, controller.signal);
      if (controller.signal.aborted) return;
      setVariants(current => [...current, file]);
      setSelected(variants.length);
      setEncoded(file);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'La création de la variante a échoué.');
    } finally {
      if (encoder.current === controller) {
        encoder.current = null;
        setEncoding(false);
      }
    }
  }

  const canEncode = baseline?.kind === 'image' && original &&
    (['image/jpeg', 'image/png'].includes(original.type) || !original.type && /\.(png|jpe?g)$/i.test(original.name));
  const activeVariant = variants[selected];
  return <section aria-labelledby={`${id}-title`} className="space-y-3 rounded-xl border border-border bg-card p-3 text-card-foreground">
    <header>
      <h3 id={`${id}-title`} className="font-semibold">Comparer des fichiers multimédias</h3>
      <p className="mt-1 text-xs text-muted-foreground">Comparez le poids et les dimensions d’images ou de vidéos sur cet appareil. Les fichiers restent dans votre navigateur.</p>
    </header>
    {showCupExample && <div className="space-y-1">
      {exampleStatus === 'idle' && <button type="button" className={buttonClass} disabled={encoding} onClick={() => void loadCupExample()}>
        Essayer avec la vidéo de la tasse
      </button>}
      {exampleStatus === 'loading' && <>
        <p role="status" className="text-xs">Chargement des trois vidéos de l’exemple…</p>
        <button type="button" className={buttonClass} onClick={cancelExample}>Annuler le chargement</button>
      </>}
      {exampleStatus === 'ready' && <>
        <p className="text-xs">Exemple de la tasse avec deux variantes pré-encodées. Le navigateur mesure les fichiers chargés. Le rapport compare aussi chaque image : <strong>qualite.mp4</strong> (CRF 22) privilégie la fidélité et <strong>legere.mp4</strong> (CRF 28) le poids.</p>
        <a href="/pura-live/essais/exemple/rapport.json" target="_blank" rel="noopener noreferrer" className="block py-1 text-xs font-medium text-primary underline">Voir les mesures de fidélité de l’exemple</a>
        <button type="button" className={buttonClass} onClick={() => chooseOriginal(null)}>Revenir à mes fichiers</button>
      </>}
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <label className="block space-y-1 text-xs font-medium">
      <span>Original</span>
      <input className={fieldClass} type="file" accept="image/*,video/*" onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) chooseOriginal(file);
      }} />
    </label>
    {original && <>
      <label className="block space-y-1 text-xs font-medium">
        <span>Ajouter des variantes</span>
        <input className={fieldClass} disabled={encoding || exampleStatus === 'loading'} type="file" accept="image/*,video/*" multiple onChange={event => {
          const added = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          if (added.length) {
            setVariants(current => [...current, ...added]);
            setSelected(variants.length);
          }
        }} />
      </label>
      {baseline?.kind === 'video' && <details className="space-y-2 text-xs">
        <summary className="cursor-pointer font-medium">Créer deux variantes vidéo sur l’ordinateur</summary>
        <a href={mediaToolUrl} download="iao-media-variants.py" className="inline-block py-1 font-medium text-primary underline">Télécharger le script vidéo (.py)</a>
        <p>Avec Python 3 et FFmpeg 6 ou ultérieur (libx264 et ffprobe), ouvrez un terminal dans le dossier du script et indiquez le chemin du clip MP4/MOV H.264 SDR de deux minutes maximum. Les pistes audio AAC sont prises en charge.</p>
        <code className="block break-words rounded-md bg-muted p-2">python3 iao-media-variants.py "ma-video.mp4"</code>
        <p>Le script crée deux fichiers et un rapport près de l’original. Il cherche au moins un tiers de poids en moins, un SSIM moyen de luminance de 0,98 ou plus, puis retient la meilleure similarité globale. Vous pouvez privilégier le poids avec <code>--prefer size</code> et ajuster le seuil avec <code>--min-ssim-y</code>. Le SSIM mesure la ressemblance des images. Visionnez les variantes pour juger le rendu.</p>
      </details>}
      {canEncode && !encoded && <div className="space-y-1">
        <button type="button" className={buttonClass} disabled={encoding || exampleStatus === 'loading'} onClick={() => void createVariant()}>
          {encoding ? 'Encodage en cours…' : 'Créer une variante locale'}
        </button>
        <p className="text-xs text-muted-foreground">Crée une image fixe aux mêmes dimensions avec une qualité d’encodage de 76 %.</p>
      </div>}
      <label className="block space-y-1 text-xs font-medium">
        <span>Réduction minimale</span>
        <select className={fieldClass} value={reduction} onChange={event => setReduction(Number(event.target.value))}>
          {[10, 25, DEFAULT_MEDIA_CRITERIA.minReductionPercent, 50, 75].map(value =>
            <option key={value} value={value}>{value === DEFAULT_MEDIA_CRITERIA.minReductionPercent ? 'Un tiers du poids' : `${value} % du poids`}</option>)}
        </select>
      </label>
      {variants.length > 1 && <label className="block space-y-1 text-xs font-medium">
        <span>Variante à comparer</span>
        <select className={fieldClass} value={selected} onChange={event => setSelected(Number(event.target.value))}>
          {variants.map((file, index) => <option key={index} value={index}>{index + 1}. {file.name}</option>)}
        </select>
      </label>}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,9rem),1fr))]">
        <MediaPreview file={original} sample={baseline} label="Original sélectionné" />
        {activeVariant && <MediaPreview file={activeVariant} sample={samples?.[selected + 1] ?? null} label="Variante sélectionnée" canDownload={activeVariant === encoded} />}
      </div>
      <div role="status" className="space-y-1 text-xs">
        {!samples && <p>Lecture des métadonnées locales…</p>}
        {samples && !baseline?.width && <p>Les dimensions de l’original sont illisibles dans ce navigateur.</p>}
        {result && <>
          <p className="break-words font-semibold">{result.winnerIndex !== null && <>{variants[result.winnerIndex].name} · </>}{result.message}</p>
          {result.maxBytes !== null && <p>Poids maximal par variante pour cet essai : {integer.format(result.maxBytes)} octets.</p>}
        </>}
      </div>
      {result && <ol className="space-y-2 text-xs">
        {result.rows.map(row => <li key={row.index} className="rounded-md border border-border p-2">
          <p className="break-all font-semibold">{variants[row.index].name}</p>
          <p>{resultLabels[row.status]}{row.reductionPercent !== null && ` · ${percent.format(row.reductionPercent)} % de réduction`}</p>
          {row.reasons.length > 0 && <p className="text-muted-foreground">{row.reasons.join(' ')}</p>}
        </li>)}
      </ol>}
      {samples && <p className="text-xs text-muted-foreground">
        L’essai vérifie le poids et les dimensions{baseline?.kind === 'video' && ` et la durée à ${percent.format(MEDIA_DURATION_TOLERANCE_SECONDS)} s près`}.
        {' '}Vérifiez le contenu{baseline?.kind === 'video' ? ', le son et la fluidité en lisant les deux vidéos' : ', les couleurs, l’orientation et les éventuelles animations dans les aperçus'}.
      </p>}
      <button type="button" className={buttonClass} onClick={() => chooseOriginal(null)}>Réinitialiser l’essai</button>
    </>}
  </section>;
}
