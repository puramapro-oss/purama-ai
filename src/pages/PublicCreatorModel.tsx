import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Copy, Loader2, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ShareButtons } from '@/components/shared/ShareButtons';
import { useAuth } from '@/hooks/useAuth';
import { useReferralTracking } from '@/hooks/useInfluencer';
import { authPagePath } from '@/lib/auth-continuation';
import { CATEGORIES, cloneTemplate, getPublicCreatorModel } from '@/lib/creator-agent';
import type { PublicCreatorModel as Model } from '@/lib/public-creator-model';
import { isValidReferralCode } from '@/lib/public-share';

export default function PublicCreatorModel() {
  const { id = '' } = useParams<{ id: string }>();
  // A different model must never inherit an earlier request, result or copy ID.
  return <ModelPreview key={id} id={id} />;
}

function ModelPreview({ id }: { id: string }) {
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { checkAndStoreReferral } = useReferralTracking();
  const [model, setModel] = useState<Model | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const currentUserId = useRef(user?.id);
  currentUserId.current = user?.id;
  const attempt = useRef<{ owner: string; id: string } | null>(null);

  const refs = new URLSearchParams(location.search).getAll('ref');
  const referralCode = refs.length === 1 && isValidReferralCode(refs[0]) ? refs[0] : undefined;
  const modelPath = `/modeles/${id.toLowerCase()}`;
  const returnPath = referralCode ? `${modelPath}?${new URLSearchParams({ ref: referralCode })}` : modelPath;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setModel(null);
    getPublicCreatorModel(id, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setModel(result);
      setStatus(result ? 'ready' : 'unavailable');
    }).catch(() => {
      if (!controller.signal.aborted) setStatus('error');
    });
    return () => controller.abort();
  }, [id, reload]);

  useEffect(() => {
    if (!model || !referralCode) return;
    try {
      // Reuse the existing attribution store, after validating the public input.
      checkAndStoreReferral();
    } catch {
      // A storage restriction must not prevent opening or copying a model.
    }
  }, [model, referralCode, checkAndStoreReferral]);

  useEffect(() => {
    if (!model) return;
    const previous = document.title;
    document.title = `${model.name} — PURAMA`;
    return () => { document.title = previous; };
  }, [model]);

  const createPrivateCopy = async () => {
    if (!user || !model || authLoading || inFlight.current) return;
    const owner = user.id;
    inFlight.current = true;
    setCopying(true);
    setCopyError(null);
    try {
      if (!attempt.current || attempt.current.owner !== owner) {
        attempt.current = { owner, id: crypto.randomUUID() };
      }
      const copy = await cloneTemplate(owner, model.id, attempt.current.id);
      if (mounted.current && currentUserId.current === owner) {
        navigate(`/dashboard/creator-agent/${copy.id}`);
      }
    } catch (error) {
      if (!mounted.current || currentUserId.current !== owner) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'P0002') {
        setModel(null);
        setStatus('unavailable');
      } else {
        setCopyError('La copie n’a pas pu être confirmée. Réessayez pour retrouver la même copie.');
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setCopying(false);
    }
  };

  const category = CATEGORIES.find(item => item.value === model?.category);

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:py-12">
      <div className="mx-auto max-w-2xl space-y-8">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> PURAMA
        </Link>

        {status === 'loading' && (
          <section className="rounded-2xl border border-border bg-card p-8" aria-busy="true">
            <h1 className="text-xl font-semibold">Ouvrir un modèle</h1>
            <p role="status" className="mt-4 flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> Chargement du modèle…
            </p>
          </section>
        )}

        {status === 'error' && (
          <section className="space-y-4 rounded-2xl border border-border bg-card p-8">
            <h1 className="text-xl font-semibold">Impossible de charger ce modèle</h1>
            <p role="alert" className="text-muted-foreground">Vérifiez votre connexion, puis réessayez.</p>
            <Button type="button" onClick={() => setReload(value => value + 1)}>Réessayer</Button>
          </section>
        )}

        {status === 'unavailable' && (
          <section className="space-y-4 rounded-2xl border border-border bg-card p-8">
            <h1 className="text-xl font-semibold">Ce modèle n’est plus disponible</h1>
            <p className="text-muted-foreground">Le lien est invalide ou son auteur a retiré le modèle.</p>
            <Button asChild variant="outline"><Link to="/forge">Découvrir le créateur d’agents</Link></Button>
          </section>
        )}

        {status === 'ready' && model && (
          <>
            <section className="overflow-hidden rounded-2xl border border-border bg-card">
              <div className="h-1" style={{ backgroundColor: model.color }} />
              <div className="space-y-6 p-6 sm:p-8">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{model.is_template ? 'Modèle PURAMA' : 'Modèle partagé'}</Badge>
                  {category && <Badge variant="secondary">{category.label}</Badge>}
                </div>
                <div className="flex items-start gap-4">
                  <span className="shrink-0 text-4xl" aria-hidden="true">{model.emoji}</span>
                  <h1 className="min-w-0 break-words text-2xl font-bold leading-tight sm:text-3xl">{model.name}</h1>
                </div>
                {model.description && <p className="whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">{model.description}</p>}

                <div className="space-y-4 border-t border-border pt-6">
                  <p className="flex items-start gap-2 text-sm text-muted-foreground">
                    <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    Une copie privée, personnalisable dans votre espace. Vous choisissez ensuite quand l’utiliser.
                  </p>
                  {authLoading ? (
                    <Button disabled className="w-full sm:w-auto"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Vérification de votre session…</Button>
                  ) : user ? (
                    <Button type="button" onClick={createPrivateCopy} disabled={copying} aria-busy={copying} className="w-full sm:w-auto">
                      {copying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                      {copying ? 'Création de votre copie…' : 'Créer ma copie privée'}
                    </Button>
                  ) : (
                    <div className="space-y-3">
                      <Button asChild className="w-full sm:w-auto"><Link to={authPagePath('/signup', returnPath)}>Créer ma copie privée <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>
                      <p className="text-sm text-muted-foreground">Déjà un compte ? <Link to={authPagePath('/login', returnPath)} className="font-medium text-foreground underline underline-offset-4">Se connecter et revenir à ce modèle</Link></p>
                    </div>
                  )}
                  {copyError && <p role="alert" className="text-sm text-destructive">{copyError}</p>}
                </div>
              </div>
            </section>

            <section className="space-y-3" aria-labelledby="public-model-share-title">
              <h2 id="public-model-share-title" className="text-lg font-semibold">Partager ce modèle</h2>
              <p className="text-sm text-muted-foreground">Le destinataire peut consulter cette présentation avant de créer son compte.</p>
              <ShareButtons path={modelPath} referralCode={referralCode} title={`${model.name} — PURAMA`} text={`Découvrez ${model.name} sur PURAMA.`} />
            </section>
          </>
        )}
      </div>
    </main>
  );
}
