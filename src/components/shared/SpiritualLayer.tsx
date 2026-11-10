import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useAwakening } from '@/hooks/useAwakening';
import { wellbeingCopy } from '@/lib/wellbeing-copy';

type Practice = 'neutral' | 'kindness' | 'spiritual';
type Feedback = 'helpful' | 'neutral' | 'uncomfortable';

function OptionalPause() {
  const { i18n } = useTranslation();
  const copy = wellbeingCopy(i18n.language);
  const { recordAffirmation } = useAwakening();
  const [open, setOpen] = useState(false);
  const [practice, setPractice] = useState<Practice | null>(null);
  const [finished, setFinished] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const recorded = useRef(false);

  const handleOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setPractice(null);
      setFinished(false);
      setFeedback(null);
      recorded.current = false;
    }
  };

  const finish = () => {
    if (recorded.current) return;
    recorded.current = true;
    recordAffirmation();
    setFinished(true);
  };

  const practiceText = practice === 'spiritual' ? copy.pause.spiritualText
    : practice === 'kindness' ? copy.pause.kindnessText : copy.pause.neutralText;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" variant="outline" lang={copy.locale} className="fixed bottom-4 left-4 z-40 max-w-[calc(100vw-6rem)] rounded-full bg-background/95 shadow-sm">
          <Sparkles aria-hidden="true" className="mr-2 h-4 w-4" />
          {copy.pause.trigger}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9999] bg-black/60" />
        <Dialog.Content
          lang={copy.locale}
          dir="ltr"
          onKeyDown={(event) => {
            // Keep unhandled Escape responsive immediately after reopening the dialog.
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            handleOpen(false);
          }}
          className="fixed left-1/2 top-1/2 z-[10000] max-h-[85vh] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-background p-6 shadow-xl"
        >
          <Dialog.Title className="text-xl font-semibold">{copy.pause.title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">{copy.pause.description}</Dialog.Description>
          <div className="my-5 space-y-3">
            {!practice ? (
              <div className="flex flex-col gap-3">
                {(['neutral', 'kindness', 'spiritual'] as const).map(value => (
                  <Button type="button" key={value} variant="outline" className="h-auto whitespace-normal py-3 text-left" onClick={() => setPractice(value)}>{copy.pause[value]}</Button>
                ))}
              </div>
            ) : !finished ? (
              <>
                <p className="leading-relaxed">{practiceText}</p>
                <Button type="button" onClick={finish} className="w-full">{copy.pause.done}</Button>
                <Button type="button" variant="outline" onClick={() => setPractice(null)} className="w-full">{copy.pause.change}</Button>
              </>
            ) : (
              <div>
                <p>{copy.common.feedback}</p>
                <div className="my-3 flex flex-wrap gap-2">
                  {(['helpful', 'neutral', 'uncomfortable'] as const).map(value => (
                    <Button type="button" variant="outline" key={value} aria-pressed={feedback === value} onClick={() => setFeedback(value)}>{copy.common[value]}</Button>
                  ))}
                </div>
                {feedback && <p role="status">{feedback === 'uncomfortable' ? copy.common.discomfort : copy.common.thanks}</p>}
              </div>
            )}
          </div>
          <p className="mb-4 text-xs text-muted-foreground">{copy.pause.note}</p>
          <Dialog.Close asChild><Button type="button" variant="outline" className="w-full">{practice && !finished ? copy.common.stop : copy.common.close}</Button></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SpiritualLayer() {
  const { user, loading } = useAuth();
  // Remount on every identity transition; an open practice or private feedback
  // must never carry over to another account. Nothing auto-opens after login.
  return loading ? null : <OptionalPause key={user?.id ?? 'anonymous'} />;
}
