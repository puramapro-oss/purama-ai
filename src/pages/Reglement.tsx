// ─── /reglement · Règlements Purama + preuve blockchain publique (V4.1) ──
import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Scale, ShieldCheck, Clock, Hash, ExternalLink, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface Reglement {
  id: string;
  version: string;
  type: 'jeu_concours' | 'prime' | 'bourse' | 'cgv';
  content_hash: string;
  opentimestamps_proof: string | null;
  blockchain: string;
  published_at: string;
  content_url: string | null;
}

interface VerifyState {
  loading: boolean;
  verified?: boolean;
  pending?: boolean;
  blockHeight?: number;
  timestamp?: string;
  error?: string;
}

const TYPE_LABELS: Record<Reglement['type'], { label: string; color: string }> = {
  jeu_concours: { label: 'Jeu-concours', color: 'bg-cyan-500/20 text-cyan-400' },
  prime: { label: 'Prime de bienvenue', color: 'bg-emerald-500/20 text-emerald-400' },
  bourse: { label: "Bourse d'inclusion", color: 'bg-purple-500/20 text-purple-400' },
  cgv: { label: 'CGV', color: 'bg-amber-500/20 text-amber-400' },
};

export default function Reglement() {
  const [reglements, setReglements] = useState<Reglement[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState<Record<string, VerifyState>>({});

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('reglements')
        .select('id, version, type, content_hash, opentimestamps_proof, blockchain, published_at, content_url')
        .order('published_at', { ascending: false });
      if (error) toast.error('Impossible de charger les règlements.');
      else setReglements((data ?? []) as Reglement[]);
      setLoading(false);
    })();
  }, []);

  const verify = async (id: string) => {
    setVerifying((v) => ({ ...v, [id]: { loading: true } }));
    try {
      const { data, error } = await supabase.functions.invoke('reglement-verify', { body: { id } });
      if (error) throw error;
      setVerifying((v) => ({ ...v, [id]: { loading: false, ...data } }));
    } catch (e) {
      setVerifying((v) => ({ ...v, [id]: { loading: false, verified: false, error: (e as Error).message } }));
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground py-12 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-4">
          <Scale className="w-8 h-8 text-accent-cyan" />
          <h1 className="text-3xl sm:text-4xl font-orbitron font-bold">Règlements Purama</h1>
        </div>
        <p className="text-muted-foreground mb-2">
          Chaque règlement de jeu-concours, prime et bourse Purama est horodaté sur la blockchain Bitcoin.
          Tu peux vérifier l'authenticité et la date de publication de n'importe quel document.
        </p>
        <p className="text-xs text-muted-foreground mb-10">
          🌱 Participation gratuite et sans obligation d'achat · Remboursement des frais sur demande via{' '}
          <a href="/aide" className="underline text-accent-cyan">/aide</a>
        </p>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-accent-cyan" />
          </div>
        ) : reglements.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center text-muted-foreground">
              Aucun règlement publié pour le moment. Les premiers règlements seront ancrés
              sur Bitcoin lors du lancement officiel des jeux-concours et primes.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {reglements.map((r) => {
              const v = verifying[r.id];
              return (
                <Card key={r.id} className="bg-secondary/30 border-accent-cyan/10">
                  <CardContent className="p-5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
                      <div className="flex items-center gap-3">
                        <Badge className={TYPE_LABELS[r.type].color}>{TYPE_LABELS[r.type].label}</Badge>
                        <span className="font-mono text-sm">v{r.version}</span>
                        <span className="text-xs text-muted-foreground">
                          <Clock className="inline w-3 h-3 mr-1" />
                          {new Date(r.published_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })}
                        </span>
                      </div>
                      {r.content_url && (
                        <a href={r.content_url} target="_blank" rel="noopener noreferrer" className="text-sm text-accent-cyan hover:underline inline-flex items-center gap-1">
                          Voir le PDF <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>

                    <div className="flex items-start gap-2 text-xs text-muted-foreground mb-3">
                      <Hash className="w-3 h-3 mt-0.5 shrink-0" />
                      <code className="font-mono break-all">{r.content_hash}</code>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => verify(r.id)}
                        disabled={v?.loading || !r.opentimestamps_proof}
                      >
                        {v?.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-1" />}
                        {r.opentimestamps_proof ? 'Vérifier sur Bitcoin' : 'Preuve en attente'}
                      </Button>
                      {v && !v.loading && v.verified && (
                        <span className="text-emerald-400 text-sm inline-flex items-center gap-1">
                          ✅ Ancré dans le bloc #{v.blockHeight} · {v.timestamp ? new Date(v.timestamp).toLocaleString('fr-FR') : ''}
                        </span>
                      )}
                      {v && !v.loading && !v.verified && v.pending && (
                        <span className="text-amber-400 text-sm">⏳ Preuve pas encore confirmée (attendre ~2-6h)</span>
                      )}
                      {v && !v.loading && !v.verified && v.error && (
                        <span className="text-red-400 text-sm">❌ {v.error}</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <div className="mt-12 p-6 rounded-lg border border-accent-purple/20 bg-accent-purple/5">
          <h2 className="font-orbitron font-bold mb-2">Comment ça marche ?</h2>
          <ol className="list-decimal pl-5 text-sm text-muted-foreground space-y-1">
            <li>Chaque règlement est un texte intégral signé par Purama.</li>
            <li>Son empreinte SHA-256 est calculée et transmise au réseau OpenTimestamps.</li>
            <li>OpenTimestamps ancre l'empreinte dans la blockchain Bitcoin (un bloc toutes les ~10 min).</li>
            <li>N'importe qui peut vérifier l'empreinte et le bloc Bitcoin associé — ici même, sans compte Purama.</li>
          </ol>
          <p className="text-xs text-muted-foreground mt-3">
            Organisateur : SASU PURAMA · 8 rue de la Chapelle, 25560 Frasne · Siège : Tribunal de Besançon ·
            Franchise TVA art.293B.
          </p>
        </div>
      </div>
    </div>
  );
}
