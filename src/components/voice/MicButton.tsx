import { Mic, MicOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { UseVoice } from '@/hooks/useVoice';

interface Props {
  voice: UseVoice;
  onTranscript: (text: string) => void;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function MicButton({ voice, onTranscript, disabled, className, size = 'md' }: Props) {
  const { isRecording, isTranscribing, startRecording, stopRecording } = voice;

  const handleClick = async () => {
    if (isTranscribing) return;
    if (isRecording) {
      const text = await stopRecording();
      if (text && text.trim()) onTranscript(text.trim());
      else if (text === null) {
        // No-op: mic permission ok but no audio captured
      }
      return;
    }
    try {
      await startRecording();
    } catch {
      toast.error('Micro indisponible', {
        description: "Autorise l'accès au microphone dans ton navigateur.",
      });
    }
  };

  const dim = size === 'sm' ? 'w-8 h-8' : size === 'lg' ? 'w-12 h-12' : 'w-10 h-10';
  const icon = size === 'sm' ? 'w-4 h-4' : size === 'lg' ? 'w-6 h-6' : 'w-5 h-5';

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      disabled={disabled || isTranscribing}
      onClick={handleClick}
      aria-label={isRecording ? 'Arrêter l\'enregistrement' : 'Dicter un message'}
      className={cn(
        dim,
        'rounded-full transition-all relative',
        isRecording && 'bg-red-500/15 border-red-500/50 text-red-400 animate-pulse',
        className,
      )}
    >
      {isTranscribing ? (
        <Loader2 className={cn(icon, 'animate-spin')} />
      ) : isRecording ? (
        <MicOff className={icon} />
      ) : (
        <Mic className={icon} />
      )}
    </Button>
  );
}
