import { Volume2, VolumeX, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { UseVoice } from '@/hooks/useVoice';

interface Props {
  voice: UseVoice;
  text: string;
  className?: string;
}

/**
 * 🔊 Button shown next to assistant messages.
 * Each instance tracks whether IT is the one currently speaking, so multiple
 * SpeakButtons in a list don't all show "playing".
 */
export function SpeakButton({ voice, text, className }: Props) {
  const { speak, stopSpeaking, isSpeaking } = voice;
  const [thisIsActive, setThisIsActive] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (thisIsActive && isSpeaking) {
      stopSpeaking();
      setThisIsActive(false);
      return;
    }
    setLoading(true);
    setThisIsActive(true);
    try {
      await speak(text);
    } finally {
      setLoading(false);
      // Clear active flag once playback ends (poll briefly)
      const watch = setInterval(() => {
        if (!isSpeaking) {
          clearInterval(watch);
          setThisIsActive(false);
        }
      }, 500);
      setTimeout(() => clearInterval(watch), 60_000);
    }
  };

  const active = thisIsActive && isSpeaking;
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={active ? 'Stopper la lecture' : 'Écouter cette réponse'}
      className={cn(
        'inline-flex items-center justify-center rounded-full w-7 h-7 border border-border bg-secondary/30 hover:bg-secondary/60 transition-all text-muted-foreground hover:text-foreground',
        active && 'bg-accent-purple/15 border-accent-purple/40 text-accent-purple animate-pulse',
        className,
      )}
    >
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : active ? (
        <VolumeX className="w-3.5 h-3.5" />
      ) : (
        <Volume2 className="w-3.5 h-3.5" />
      )}
    </button>
  );
}
