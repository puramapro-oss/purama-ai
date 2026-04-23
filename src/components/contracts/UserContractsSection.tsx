// Section "Mes contrats" — reusable in any user profile/dashboard page
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FileText, Shield, ExternalLink, Loader2 } from 'lucide-react';

interface Contract {
  id: string;
  template_slug: string;
  status: string;
  commission_rate: number | null;
  created_at: string;
  signed_at: string | null;
  ots_block_height: number | null;
  metadata: Record<string, unknown>;
}

const STATUS: Record<string, { label: string; color: string }> = {
  draft:     { label: 'Brouillon', color: 'bg-gray-500' },
  sent:      { label: 'En attente', color: 'bg-blue-500' },
  opened:    { label: 'Ouvert',    color: 'bg-amber-500' },
  signed:    { label: 'Signé',     color: 'bg-emerald-600' },
  declined:  { label: 'Refusé',    color: 'bg-red-600' },
  cancelled: { label: 'Annulé',    color: 'bg-gray-600' },
  expired:   { label: 'Expiré',    color: 'bg-orange-600' },
};

function tierFromTemplate(slug: string): string | null {
  if (!slug.startsWith('ambassadeur-')) return null;
  const tier = slug.replace('ambassadeur-', '');
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export function UserContractsSection({ userId }: { userId?: string }) {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let q = supabase.from('contracts' as never)
      .select('id, template_slug, status, commission_rate, created_at, signed_at, ots_block_height, metadata')
      .order('created_at', { ascending: false });
    if (userId) q = q.eq('user_id', userId);
    q.then(({ data, error }) => {
      if (!error) setContracts((data as unknown as Contract[]) ?? []);
      setLoading(false);
    });
  }, [userId]);

  const activeTier = contracts
    .filter(c => c.status === 'signed' && c.template_slug.startsWith('ambassadeur-'))
    .map(c => tierFromTemplate(c.template_slug))
    .filter(Boolean)[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" /> Mes contrats
          {activeTier && (
            <Badge className="ml-auto bg-gradient-to-r from-fuchsia-600 to-purple-600 text-white">
              Ambassadeur {activeTier}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 py-4"><Loader2 className="animate-spin h-4 w-4" /> Chargement…</div>
        ) : contracts.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <p>Aucun contrat pour le moment.</p>
            <Button asChild className="mt-4" size="sm">
              <a href="/ambassadeur/rejoindre">Devenir ambassadeur</a>
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {contracts.map(c => {
              const s = STATUS[c.status] ?? { label: c.status, color: 'bg-gray-500' };
              return (
                <div key={c.id} className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{c.template_slug}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(c.created_at).toLocaleDateString('fr-FR')}
                      {c.commission_rate && ` · ${c.commission_rate}% commission`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    {c.ots_block_height && (
                      <a
                        href={`https://blockstream.info/block-height/${c.ots_block_height}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`Bloc Bitcoin #${c.ots_block_height}`}
                        className="p-1 hover:bg-muted rounded"
                      >
                        <Shield className="h-4 w-4 text-emerald-600" />
                      </a>
                    )}
                    <Badge className={`${s.color} text-white text-xs`}>{s.label}</Badge>
                    {c.status === 'sent' && (
                      <Button size="sm" variant="ghost" asChild>
                        <a href={`mailto:${c.metadata?.signer_email ?? ''}`}>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
