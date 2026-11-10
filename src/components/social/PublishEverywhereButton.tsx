import { useRef, useState } from 'react';
import { Send, Loader2, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { publishEverywhere, type Platform } from '@/lib/social';
import { publicationLabel, type PublicationResult, type PublicationStatus } from '@/lib/social-publish-request';

interface Props {
  content: string;
  mediaUrls?: string[];
  contentType?: 'text' | 'image' | 'video' | 'carousel' | 'reel';
  agentName?: string;
  platforms?: Platform[];
  onPublished?: (postId: string) => void;
  className?: string;
}

type Status = 'idle' | 'publishing' | 'error' | PublicationStatus;

export function PublishEverywhereButton({
  content,
  mediaUrls,
  contentType = 'text',
  agentName,
  platforms,
  onPublished,
  className,
}: Props) {
  const fingerprint = JSON.stringify({ content, mediaUrls, contentType, agentName, platforms });
  const [state, setState] = useState<{ fingerprint: string; status: Status; result?: PublicationResult }>({ fingerprint, status: 'idle' });
  const inFlight = useRef(false);
  const status = state.status === 'publishing' || state.fingerprint === fingerprint ? state.status : 'idle';
  const result = state.fingerprint === fingerprint ? state.result : undefined;

  const handlePublish = async () => {
    if (inFlight.current) return;
    if (!content.trim() && (!mediaUrls || mediaUrls.length === 0)) {
      toast.error('Aucun contenu à publier');
      return;
    }
    inFlight.current = true;
    setState({ fingerprint, status: 'publishing' });
    try {
      const result = await publishEverywhere({
        content,
        mediaUrls,
        contentType,
        agentName,
        platforms,
      });
      setState({ fingerprint, status: result.status, result });
      if (result.status === 'published') {
        toast.success(publicationLabel(result.status), { description: 'Le fournisseur a confirmé les destinations demandées.' });
        onPublished?.(result.post_id);
      } else if (result.status === 'scheduled') {
        toast.info(publicationLabel(result.status), { description: 'La demande est enregistrée pour la date prévue.' });
      } else {
        toast.warning(publicationLabel(result.status), {
          description: result.error || 'Consultez le résultat par réseau. Aucun renvoi automatique.',
        });
      }
    } catch (error) {
      setState({ fingerprint, status: 'error' });
      const message = error instanceof Error ? error.message : String(error);
      toast.warning('Résultat non confirmé', { description: message });
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <div className="space-y-2">
      <Button
        onClick={handlePublish}
        disabled={status === 'publishing' || status === 'published' || status === 'scheduled' || status === 'partial' || status === 'failed'}
        variant={status === 'published' ? 'outline' : 'default'}
        className={className ?? 'gap-2 bg-gradient-to-r from-accent-cyan to-accent-purple text-primary-foreground hover:opacity-90'}
      >
        {status === 'idle' && <><Send className="w-4 h-4" /> Publier sur mes réseaux</>}
        {status === 'publishing' && <><Loader2 className="w-4 h-4 animate-spin" /> Vérification en cours…</>}
        {status === 'published' && <><Check className="w-4 h-4 text-green-500" /> Publication confirmée</>}
        {status === 'scheduled' && 'Publication programmée'}
        {status === 'partial' && <><AlertCircle className="w-4 h-4" /> Publication partielle</>}
        {status === 'failed' && <><AlertCircle className="w-4 h-4" /> Publication non effectuée</>}
        {(status === 'error' || status === 'publish_unconfirmed') && <><AlertCircle className="w-4 h-4" /> Vérifier le résultat</>}
      </Button>
      {(status === 'error' || status === 'publish_unconfirmed') && (
        <p role="status" className="text-xs text-amber-500">Résultat à confirmer. Cette vérification conserve la même demande, sans nouvelle publication.</p>
      )}
      {result?.platform_results && result.platform_results.length > 0 && (
        <ul aria-label="Résultat par réseau" className="text-xs text-muted-foreground space-y-1">
          {result.platform_results.map((platform, index) => (
            <li key={`${platform.platform}-${platform.accountId}-${index}`}>
              {platform.platform} : {platform.status === 'published' ? 'publié' : platform.status === 'failed' ? 'échec confirmé' : 'à confirmer'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
