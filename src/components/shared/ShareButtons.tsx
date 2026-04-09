import { useState } from 'react';
import { Share2, Copy, Check, MessageCircle, Send, Twitter, Facebook, Linkedin, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';

interface ShareButtonsProps {
  title?: string;
  text?: string;
  compact?: boolean;
}

export function ShareButtons({ title = 'Purama AI', text = 'Découvre Purama AI — des agents IA autonomes pour automatiser ton business !', compact = false }: ShareButtonsProps) {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);

  const shareCode = user?.id?.slice(0, 8) || 'purama';
  const shareUrl = `https://purama-ai.purama.dev/signup?ref=${shareCode}`;
  const encodedText = encodeURIComponent(`${text}\n${shareUrl}`);
  const encodedUrl = encodeURIComponent(shareUrl);

  const copyLink = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    toast.success('Lien copié !');
    setTimeout(() => setCopied(false), 2000);
  };

  const nativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url: shareUrl });
      } catch {
        // User cancelled
      }
    } else {
      copyLink();
    }
  };

  const platforms = [
    { name: 'WhatsApp', icon: MessageCircle, href: `https://wa.me/?text=${encodedText}`, color: 'hover:text-green-400' },
    { name: 'Telegram', icon: Send, href: `https://t.me/share/url?url=${encodedUrl}&text=${encodeURIComponent(text)}`, color: 'hover:text-blue-400' },
    { name: 'Twitter', icon: Twitter, href: `https://twitter.com/intent/tweet?text=${encodedText}`, color: 'hover:text-sky-400' },
    { name: 'Facebook', icon: Facebook, href: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`, color: 'hover:text-blue-500' },
    { name: 'LinkedIn', icon: Linkedin, href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`, color: 'hover:text-blue-600' },
    { name: 'Email', icon: Mail, href: `mailto:?subject=${encodeURIComponent(title)}&body=${encodedText}`, color: 'hover:text-accent-cyan' },
  ];

  if (compact) {
    return (
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={nativeShare} className="text-muted-foreground hover:text-accent-cyan">
          <Share2 className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={copyLink} className="text-muted-foreground hover:text-accent-cyan">
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button onClick={nativeShare} className="bg-gradient-to-r from-accent-purple to-accent-cyan">
          <Share2 className="w-4 h-4 mr-2" />
          Partager
        </Button>
        <Button variant="outline" onClick={copyLink}>
          {copied ? <Check className="w-4 h-4 mr-2 text-green-400" /> : <Copy className="w-4 h-4 mr-2" />}
          {copied ? 'Copié !' : 'Copier le lien'}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {platforms.map((p) => (
          <a key={p.name} href={p.href} target="_blank" rel="noopener noreferrer">
            <Button variant="ghost" size="sm" className={`text-muted-foreground ${p.color}`}>
              <p.icon className="w-4 h-4 mr-1" />
              {p.name}
            </Button>
          </a>
        ))}
      </div>
    </div>
  );
}
