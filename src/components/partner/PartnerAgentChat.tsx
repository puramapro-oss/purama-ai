import { useLayoutEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Loader2 } from 'lucide-react';
import { AgentChatTab } from '@/components/voice/AgentChatTab';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { useRequestScope, useScopedState } from '@/hooks/useRequestScope';
import { createRequestScope } from '@/lib/request-scope';
import { contractFeedback, generateContract, type PartnerContractResult, type PartnerProspect } from '@/lib/partner';

/** The chat prepares advice; this explicit button reuses the existing contract workflow. */
export function PartnerAgentChat({ prospects }: { prospects: PartnerProspect[] }) {
  const { user } = useAuth();
  const ownerKey = user?.id ?? '';
  const [selectedId, setSelectedId] = useScopedState(ownerKey, '');
  const ownProspects = prospects.filter(prospect => prospect.user_id === ownerKey);
  const selected = ownProspects.find(prospect => prospect.id === selectedId);
  const prospectId = selected?.id;
  const contextKey = JSON.stringify([ownerKey, prospectId ?? null]);
  const currentScope = useRequestScope(contextKey);
  const [requests] = useState(createRequestScope);
  const [preparing, setPreparing] = useScopedState(contextKey, false);
  const [result, setResult] = useScopedState<PartnerContractResult | null>(contextKey, null);
  const [failure, setFailure] = useScopedState<string | null>(contextKey, null);

  useLayoutEffect(() => {
    // A -> B -> A is a new lifetime, including when no write occurred in B.
    setPreparing(false);
    setResult(null);
    setFailure(null);
    return () => requests.invalidate();
  }, [contextKey, requests, setPreparing, setResult, setFailure]);

  const prepareContract = async () => {
    const isCurrent = currentScope();
    if (!ownerKey || !selected || !isCurrent()) return;
    const request = requests.begin('contract');
    if (!request) return;
    setPreparing(true);
    setFailure(null);
    setResult(null);
    try {
      const next = await generateContract(selected.id);
      if (request.current() && isCurrent()) setResult(next);
    } catch (error) {
      if (request.current() && isCurrent()) setFailure(error instanceof Error ? error.message : 'La préparation du contrat est indisponible.');
    } finally {
      if (request.finish() && isCurrent()) setPreparing(false);
    }
  };

  const feedback = result ? contractFeedback(result) : null;
  const canPrepare = !!selected?.email && ['interested', 'contract_sent'].includes(selected.status);

  return (
    <section className="space-y-3" aria-label="Assistant IAO Partenariats">
      <Card className="bg-card border-border">
        <CardContent className="p-4 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="partner-chat-prospect" className="text-sm font-medium">Dossier pour cette conversation</label>
            <select id="partner-chat-prospect" value={prospectId ?? ''} onChange={event => setSelectedId(event.target.value)}
              className="w-full rounded-md border border-input bg-background p-2 text-sm">
              <option value="">Conseils généraux</option>
              {ownProspects.map(prospect => <option key={prospect.id} value={prospect.id}>{prospect.name}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">
              IAO utilise le dossier choisi et les conditions enregistrées. Changer de dossier ouvre une conversation séparée.
            </p>
          </div>
          {selected && <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void prepareContract()} disabled={preparing || !canPrepare}>
                {preparing ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                  : <FileText aria-hidden="true" className="mr-2 h-4 w-4" />}
                {preparing ? 'Préparation du contrat…' : 'Préparer le contrat'}
              </Button>
              <Button variant="outline" asChild><Link to={`/dashboard/partner-agent/prospects?contractProspect=${encodeURIComponent(selected.id)}`}>
                Ouvrir la revue du contrat
              </Link></Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {canPrepare ? 'Le PDF est préparé sans envoi. Vérifie ensuite sa version exacte et son destinataire avant de l’approuver.'
                : 'La préparation du contrat nécessite un prospect intéressé et une adresse email enregistrée.'}
            </p>
          </div>}
          {feedback && <div role="status" className="rounded-md border border-border p-3 text-sm">
            <p className="font-medium">{feedback.title}</p>
            <p className="text-muted-foreground">{feedback.description}</p>
            {result?.status === 'pending_approval' && <p className="mt-1 text-xs text-muted-foreground">La revue du contrat donne accès au PDF et à sa confirmation d’envoi.</p>}
          </div>}
          {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
        </CardContent>
      </Card>
      <AgentChatTab
        agentType="partner" agentName="IAO Partenariats" agentEmoji="🤝" agentColor="#A855F7"
        prospectId={prospectId}
        suggestions={selected ? [
          'Résume ce dossier et les informations encore manquantes.',
          'Prépare un brouillon de message adapté à ce partenaire.',
          'Explique les conditions enregistrées sans les modifier.',
          'Quels points vérifier avant de proposer le contrat ?',
        ] : [
          'Aide-moi à qualifier un partenaire.',
          'Quels indicateurs suivre pour mes partenariats ?',
          'Comment préparer une proposition transparente ?',
          'Comment choisir la prochaine action dans mes dossiers ?',
        ]}
      />
    </section>
  );
}
