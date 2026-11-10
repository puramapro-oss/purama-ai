import { useEffect, useRef, useState } from 'react';
import { Wind } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { useAwakening } from '@/hooks/useAwakening';
import { wellbeingCopy } from '@/lib/wellbeing-copy';

type PauseStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'complete';
type Feedback = 'helpful' | 'neutral' | 'uncomfortable';

function BreathingPause() {
  const { i18n } = useTranslation();
  const copy = wellbeingCopy(i18n.language);
  const { recordBreathSession } = useAwakening();
  const [duration, setDuration] = useState(60);
  const [remaining, setRemaining] = useState(60);
  const [status, setStatus] = useState<PauseStatus>('idle');
  const [confirmed, setConfirmed] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const recorded = useRef(false);

  useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => setRemaining(value => Math.max(0, value - 1)), 1000);
    const pauseWhenHidden = () => {
      if (document.hidden) setStatus('paused');
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', pauseWhenHidden);
    };
  }, [status]);

  useEffect(() => {
    if (status === 'running' && remaining === 0) setStatus('complete');
  }, [remaining, status]);

  const start = () => {
    if (status !== 'paused') {
      setRemaining(duration);
      setConfirmed(false);
      setFeedback(null);
      recorded.current = false;
    }
    setStatus('running');
  };

  const stop = () => {
    setStatus('stopped');
    setFeedback(null);
    setConfirmed(false);
  };

  const confirmCompletion = () => {
    if (recorded.current || status !== 'complete') return;
    recorded.current = true;
    recordBreathSession();
    setConfirmed(true);
  };

  const label = status === 'idle' ? copy.breath.ready : copy.breath[status];
  const active = status === 'running' || status === 'paused';

  return (
    <div lang={copy.locale} dir="ltr" className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="flex items-center gap-3 text-2xl font-bold"><Wind aria-hidden="true" className="h-7 w-7" />{copy.breath.title}</h1>
        <p className="mt-2 text-muted-foreground">{copy.breath.description}</p>
      </div>
      <Card><CardContent className="space-y-3 pt-6"><p>{copy.breath.instructions}</p><p className="text-sm text-muted-foreground">{copy.breath.alternative}</p></CardContent></Card>
      <label className="flex flex-wrap items-center gap-3">
        {copy.breath.duration}
        <select value={duration} disabled={active} className="rounded border border-border bg-background p-2" onChange={event => {
          const next = Number(event.target.value);
          if (![30, 60, 120].includes(next)) return;
          setDuration(next); setRemaining(next); setStatus('idle'); setFeedback(null); setConfirmed(false);
        }}>
          {[30, 60, 120].map(value => <option key={value} value={value}>{value} {copy.breath.seconds}</option>)}
        </select>
      </label>
      <div className="mx-auto flex h-52 w-52 flex-col items-center justify-center rounded-full border border-border bg-card text-center">
        <p role="status" className="mb-3 text-sm">{label}</p>
        <p data-testid="breathing-countdown" aria-label={copy.breath.remaining} className="text-4xl tabular-nums">{remaining}</p>
        <span className="text-sm text-muted-foreground">{copy.breath.seconds}</span>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        {status === 'running' ? <Button type="button" onClick={() => setStatus('paused')}>{copy.breath.pause}</Button>
          : <Button type="button" onClick={start}>{status === 'paused' ? copy.breath.resume : status === 'idle' ? copy.breath.start : copy.breath.restart}</Button>}
        {active && <Button type="button" onClick={stop} variant="outline">{copy.common.stop}</Button>}
      </div>
      {status === 'complete' && <Card><CardContent className="space-y-3 pt-6">
        <p>{copy.breath.result}</p>
        {!confirmed ? <Button type="button" onClick={confirmCompletion}>{copy.pause.done}</Button> : <>
          <p>{copy.common.feedback}</p>
          <div className="flex flex-wrap gap-2">{(['helpful', 'neutral', 'uncomfortable'] as const).map(value => <Button type="button" variant="outline" key={value} aria-pressed={feedback === value} onClick={() => setFeedback(value)}>{copy.common[value]}</Button>)}</div>
          {feedback && <p role="status">{feedback === 'uncomfortable' ? copy.common.discomfort : copy.common.thanks}</p>}
        </>}
      </CardContent></Card>}
    </div>
  );
}

export default function Breathe() {
  const { user, loading } = useAuth();
  return loading ? null : <BreathingPause key={user?.id ?? 'anonymous'} />;
}
