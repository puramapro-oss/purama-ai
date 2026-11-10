import { useEffect, useId, useRef, useState } from 'react';
import { Share2, Copy, Check, MessageCircle, Send, Twitter, Facebook, Linkedin, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { buildPublicShareUrl } from '@/lib/public-share';

interface ShareButtonsProps {
  title?: string;
  text?: string;
  compact?: boolean;
  path?: string;
  referralCode?: string;
}

export function ShareButtons({
  title = 'Purama AI',
  text = 'Découvre Purama AI — des agents IA autonomes pour automatiser ton business !',
  compact = false,
  path,
  referralCode,
}: ShareButtonsProps) {
  const shareUrl = buildPublicShareUrl({
    origin: typeof window === 'undefined' ? '' : window.location.origin,
    path,
    referralCode,
  });

  // A new destination owns new state: an old clipboard/share promise must not
  // confirm success, unlock controls or display a link for the next destination.
  return <ShareActions key={shareUrl ?? 'unavailable'} shareUrl={shareUrl} title={title} text={text} compact={compact} />;
}

interface ShareActionsProps {
  shareUrl: string | null;
  title: string;
  text: string;
  compact: boolean;
}

function ShareActions({ shareUrl, title, text, compact }: ShareActionsProps) {
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [manualReason, setManualReason] = useState<'copy' | 'share' | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualInput = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const inputId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current = false;
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    };
  }, []);

  useEffect(() => {
    if (manualReason) {
      manualInput.current?.focus();
      manualInput.current?.select();
    }
  }, [manualReason]);

  const beginAction = () => {
    // React state alone does not stop two clicks occurring before a render.
    if (!shareUrl || inFlight.current || !mounted.current) return false;
    inFlight.current = true;
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    setCopied(false);
    setManualReason(null);
    setPending(true);
    return true;
  };

  const finishAction = () => {
    inFlight.current = false;
    if (mounted.current) setPending(false);
  };

  const copyPublicLink = async () => {
    if (!shareUrl) return;
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        if (mounted.current) setManualReason('copy');
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      if (!mounted.current) return;
      setCopied(true);
      toast.success('Lien copié !');
      resetTimer.current = setTimeout(() => {
        resetTimer.current = null;
        if (mounted.current) setCopied(false);
      }, 2000);
    } catch {
      if (mounted.current) setManualReason('copy');
    }
  };

  const copyLink = async () => {
    if (!beginAction()) return;
    try {
      await copyPublicLink();
    } finally {
      finishAction();
    }
  };

  const nativeShare = async () => {
    if (!beginAction()) return;
    try {
      if (typeof navigator.share === 'function' && shareUrl) {
        await navigator.share({ title, text, url: shareUrl });
      } else {
        await copyPublicLink();
      }
    } catch (error) {
      const cancelled = typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
      if (!cancelled && mounted.current) {
        setManualReason('share');
      }
    } finally {
      finishAction();
    }
  };

  // URLSearchParams encodes Unicode as scalar values, including a safe
  // replacement for a truncated surrogate from externally supplied text.
  const shareText = text + '\n' + (shareUrl ?? '');
  const platforms = [
    { name: 'WhatsApp', icon: MessageCircle, href: 'https://wa.me/?' + new URLSearchParams({ text: shareText }), color: 'hover:text-green-400' },
    { name: 'Telegram', icon: Send, href: 'https://t.me/share/url?' + new URLSearchParams({ url: shareUrl ?? '', text }), color: 'hover:text-blue-400' },
    { name: 'Twitter', icon: Twitter, href: 'https://twitter.com/intent/tweet?' + new URLSearchParams({ text: shareText }), color: 'hover:text-sky-400' },
    { name: 'Facebook', icon: Facebook, href: 'https://www.facebook.com/sharer/sharer.php?' + new URLSearchParams({ u: shareUrl ?? '' }), color: 'hover:text-blue-500' },
    { name: 'LinkedIn', icon: Linkedin, href: 'https://www.linkedin.com/sharing/share-offsite/?' + new URLSearchParams({ url: shareUrl ?? '' }), color: 'hover:text-blue-600' },
    { name: 'Email', icon: Mail, href: 'mailto:?' + new URLSearchParams({ subject: title, body: shareText }).toString().replace(/\+/g, '%20'), color: 'hover:text-accent-cyan' },
  ];

  const disabled = !shareUrl || pending;
  const message = !shareUrl
    ? 'Partage indisponible pour cette destination.'
    : manualReason === 'copy'
      ? 'La copie automatique est indisponible. Sélectionne le lien ci-dessous pour le copier.'
      : manualReason === 'share'
        ? 'Le partage automatique est indisponible. Tu peux copier le lien ci-dessous.'
        : copied ? 'Lien copié.' : '';

  return (
    <div className={compact ? 'min-w-0 space-y-2' : 'min-w-0 space-y-3'}>
      <div className="flex flex-wrap items-center gap-2" aria-busy={pending}>
        <Button
          type="button"
          variant={compact ? 'ghost' : 'default'}
          size={compact ? 'sm' : 'default'}
          onClick={nativeShare}
          disabled={disabled}
          aria-label="Partager le lien"
          aria-describedby={statusId}
          className={compact ? 'text-muted-foreground hover:text-accent-cyan' : 'bg-gradient-to-r from-accent-purple to-accent-cyan'}
        >
          <Share2 className="w-4 h-4" aria-hidden="true" />
          {!compact && 'Partager'}
        </Button>
        <Button
          type="button"
          variant={compact ? 'ghost' : 'outline'}
          size={compact ? 'sm' : 'default'}
          onClick={copyLink}
          disabled={disabled}
          aria-label="Copier le lien"
          aria-describedby={statusId}
          className={compact ? 'text-muted-foreground hover:text-accent-cyan' : undefined}
        >
          {copied ? <Check className="w-4 h-4 text-green-400" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
          {!compact && (copied ? 'Copié !' : 'Copier le lien')}
        </Button>
      </div>
      {!compact && (
        <div className="flex flex-wrap gap-2">
          {platforms.map((platform) => shareUrl ? (
            <Button key={platform.name} asChild variant="ghost" size="sm" className={'text-muted-foreground ' + platform.color}>
              <a href={platform.href} target="_blank" rel="noopener noreferrer" aria-label={'Partager via ' + platform.name}>
                <platform.icon className="w-4 h-4" aria-hidden="true" />
                {platform.name}
              </a>
            </Button>
          ) : (
            <Button key={platform.name} type="button" variant="ghost" size="sm" disabled>
              <platform.icon className="w-4 h-4" aria-hidden="true" />
              {platform.name}
            </Button>
          ))}
        </div>
      )}
      <p id={statusId} role="status" aria-live="polite" aria-atomic="true" className="text-sm text-muted-foreground">
        {message}
      </p>
      {manualReason && shareUrl && (
        <div className="space-y-1">
          <label htmlFor={inputId} className="text-sm font-medium">Lien public à copier</label>
          <input
            id={inputId}
            ref={manualInput}
            type="text"
            readOnly
            value={shareUrl}
            aria-describedby={statusId}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
            className="w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      )}
    </div>
  );
}
