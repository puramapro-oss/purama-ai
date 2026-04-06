import { useState } from 'react';
import { Send, Loader2, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { publishEverywhere, type Platform } from '@/lib/social';

interface Props {
  content: string;
  mediaUrls?: string[];
  contentType?: 'text' | 'image' | 'video' | 'carousel' | 'reel';
  agentName?: string;
  platforms?: Platform[];
  onPublished?: (postId: string) => void;
  className?: string;
}

type Status = 'idle' | 'publishing' | 'done' | 'error';

export function PublishEverywhereButton({
  content,
  mediaUrls,
  contentType = 'text',
  agentName,
  platforms,
  onPublished,
  className,
}: Props) {
  const [status, setStatus] = useState<Status>('idle');

  const handlePublish = async () => {
    if (!content && (!mediaUrls || mediaUrls.length === 0)) {
      toast.error('Aucun contenu à publier');
      return;
    }
    setStatus('publishing');
    try {
      const result = await publishEverywhere({
        content,
        mediaUrls,
        contentType,
        agentName,
        platforms,
      });
      setStatus('done');
      toast.success('✅ Publié partout !', {
        description: 'Votre contenu est en route sur tous vos réseaux.',
      });
      onPublished?.(result.post_id);
      setTimeout(() => setStatus('idle'), 4000);
    } catch (error) {
      setStatus('error');
      const message = error instanceof Error ? error.message : String(error);
      toast.error('❌ Échec de la publication', { description: message });
      setTimeout(() => setStatus('idle'), 4000);
    }
  };

  return (
    <Button
      onClick={handlePublish}
      disabled={status === 'publishing'}
      variant={status === 'done' ? 'outline' : 'default'}
      className={
        className ??
        'gap-2 bg-gradient-to-r from-accent-cyan to-accent-purple text-primary-foreground hover:opacity-90'
      }
    >
      {status === 'idle' && (
        <>
          <Send className="w-4 h-4" /> Publier partout
        </>
      )}
      {status === 'publishing' && (
        <>
          <Loader2 className="w-4 h-4 animate-spin" /> Publication...
        </>
      )}
      {status === 'done' && (
        <>
          <Check className="w-4 h-4 text-green-500" /> Publié !
        </>
      )}
      {status === 'error' && (
        <>
          <AlertCircle className="w-4 h-4 text-red-500" /> Réessayer
        </>
      )}
    </Button>
  );
}
