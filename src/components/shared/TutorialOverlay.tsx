import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, X, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface TutorialStep {
  /**
   * CSS selector for the element to spotlight. If null, the step is shown
   * centered (full-screen welcome / outro).
   */
  selector: string | null;
  title: string;
  body: string;
  /** Optional hint position around the spotlight. */
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center';
}

interface Props {
  /** Stable id used as the localStorage key (one per agent page). */
  storageKey: string;
  steps: TutorialStep[];
  /**
   * If true, force the tutorial to show even if it was completed before.
   * Useful for the "Relancer le tuto" button on /guide.
   */
  force?: boolean;
  /** Optional delay before auto-showing the tutorial on first visit (ms). */
  autoStartDelayMs?: number;
}

const SPOTLIGHT_PADDING = 8;

/**
 * Tutorial overlay with SVG spotlight + spring animation.
 * - Stores completion in localStorage (per storageKey).
 * - Each step targets a CSS selector for the spotlight cutout.
 * - The first/last step can be center-screen (no selector) for welcome/outro.
 */
export function TutorialOverlay({
  storageKey,
  steps,
  force = false,
  autoStartDelayMs = 1500,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Decide whether to auto-show
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (force) {
      setIsOpen(true);
      setStepIndex(0);
      return;
    }
    const done = localStorage.getItem(`tuto-${storageKey}`);
    if (done) return;
    const t = setTimeout(() => {
      setIsOpen(true);
      setStepIndex(0);
    }, autoStartDelayMs);
    return () => clearTimeout(t);
  }, [storageKey, force, autoStartDelayMs]);

  // Listen for the global "relaunch tutorial" event (from /guide)
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ key: string }>;
      if (ce.detail?.key === storageKey || !ce.detail?.key) {
        setIsOpen(true);
        setStepIndex(0);
      }
    };
    window.addEventListener(`tuto-relaunch`, handler as EventListener);
    return () => window.removeEventListener(`tuto-relaunch`, handler as EventListener);
  }, [storageKey]);

  // Compute the spotlight rect when step changes
  useEffect(() => {
    if (!isOpen) return;
    const step = steps[stepIndex];
    if (!step?.selector) {
      setRect(null);
      return;
    }
    // Wait one frame for DOM to settle
    const compute = () => {
      const el = document.querySelector(step.selector!);
      if (el) {
        setRect(el.getBoundingClientRect());
        // Make sure the element is visible
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        setRect(null);
      }
    };
    const t = setTimeout(compute, 50);
    // Recompute on resize / scroll
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [isOpen, stepIndex, steps]);

  const close = (markDone: boolean) => {
    setIsOpen(false);
    if (markDone && typeof window !== 'undefined') {
      localStorage.setItem(`tuto-${storageKey}`, '1');
    }
  };

  const next = () => {
    if (stepIndex < steps.length - 1) {
      setStepIndex(stepIndex + 1);
    } else {
      close(true);
    }
  };

  const prev = () => {
    if (stepIndex > 0) setStepIndex(stepIndex - 1);
  };

  if (!isOpen || steps.length === 0) return null;
  const step = steps[stepIndex];

  // SVG mask for the spotlight effect
  const w = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const h = typeof window !== 'undefined' ? window.innerHeight : 1080;

  // Hint card position
  const cardWidth = 360;
  const cardOffset = 24;
  const cardStyle: React.CSSProperties = {
    position: 'fixed',
    width: cardWidth,
    maxWidth: 'calc(100vw - 32px)',
    zIndex: 10001,
  };
  if (rect && step.selector) {
    const pos = step.position ?? 'bottom';
    if (pos === 'bottom') {
      cardStyle.left = Math.max(16, Math.min(w - cardWidth - 16, rect.left + rect.width / 2 - cardWidth / 2));
      cardStyle.top = rect.bottom + cardOffset;
      // Flip to top if it overflows
      if ((cardStyle.top as number) + 260 > h) {
        cardStyle.top = Math.max(16, rect.top - 260 - cardOffset);
      }
    } else if (pos === 'top') {
      cardStyle.left = Math.max(16, Math.min(w - cardWidth - 16, rect.left + rect.width / 2 - cardWidth / 2));
      cardStyle.top = Math.max(16, rect.top - 260 - cardOffset);
    } else if (pos === 'right') {
      cardStyle.left = Math.min(w - cardWidth - 16, rect.right + cardOffset);
      cardStyle.top = Math.max(16, rect.top + rect.height / 2 - 130);
    } else if (pos === 'left') {
      cardStyle.left = Math.max(16, rect.left - cardWidth - cardOffset);
      cardStyle.top = Math.max(16, rect.top + rect.height / 2 - 130);
    }
  } else {
    // Centered card (welcome / no selector)
    cardStyle.left = '50%';
    cardStyle.top = '50%';
    cardStyle.transform = 'translate(-50%, -50%)';
  }

  return (
    <AnimatePresence>
      <motion.div
        ref={overlayRef}
        key="tuto-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[10000] pointer-events-auto"
        style={{ touchAction: 'none' }}
      >
        {/* SVG dark backdrop with cutout */}
        <svg width="100%" height="100%" className="absolute inset-0 pointer-events-none">
          <defs>
            <mask id="tuto-mask">
              <rect width="100%" height="100%" fill="white" />
              {rect && (
                <motion.rect
                  initial={false}
                  animate={{
                    x: rect.left - SPOTLIGHT_PADDING,
                    y: rect.top - SPOTLIGHT_PADDING,
                    width: rect.width + SPOTLIGHT_PADDING * 2,
                    height: rect.height + SPOTLIGHT_PADDING * 2,
                  }}
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                  rx={12}
                  ry={12}
                  fill="black"
                />
              )}
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="rgba(0,0,0,0.72)"
            mask="url(#tuto-mask)"
          />
          {/* Glowing border around the spotlight */}
          {rect && (
            <motion.rect
              initial={false}
              animate={{
                x: rect.left - SPOTLIGHT_PADDING,
                y: rect.top - SPOTLIGHT_PADDING,
                width: rect.width + SPOTLIGHT_PADDING * 2,
                height: rect.height + SPOTLIGHT_PADDING * 2,
              }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              rx={12}
              ry={12}
              fill="none"
              stroke="rgba(139, 92, 246, 0.7)"
              strokeWidth="2"
              style={{ filter: 'drop-shadow(0 0 12px rgba(139, 92, 246, 0.6))' }}
            />
          )}
        </svg>

        {/* Click-catcher behind the card to close on outside click */}
        <div
          className="absolute inset-0 cursor-pointer"
          onClick={() => close(false)}
        />

        {/* Hint card */}
        <motion.div
          key={`tuto-card-${stepIndex}`}
          initial={{ opacity: 0, scale: 0.95, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 320, damping: 26 }}
          style={cardStyle}
          onClick={e => e.stopPropagation()}
          className="rounded-2xl border border-accent-purple/40 bg-card/95 backdrop-blur-xl shadow-[0_20px_60px_rgba(139,92,246,0.25)] p-5"
        >
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-accent-purple/15 flex items-center justify-center">
                <Sparkles className="w-3.5 h-3.5 text-accent-purple" />
              </div>
              <span className="text-[11px] uppercase tracking-wide text-accent-purple font-semibold">
                Étape {stepIndex + 1} / {steps.length}
              </span>
            </div>
            <button
              type="button"
              onClick={() => close(true)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Fermer le tutoriel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <h3 className="text-base font-semibold text-foreground mb-2">{step.title}</h3>
          <p className="text-xs text-muted-foreground leading-relaxed mb-4">{step.body}</p>

          {/* Step dots */}
          <div className="flex gap-1 mb-4">
            {steps.map((_, i) => (
              <span
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i === stepIndex ? 'bg-accent-purple' : i < stepIndex ? 'bg-accent-purple/40' : 'bg-secondary'
                }`}
              />
            ))}
          </div>

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => close(true)}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Passer
            </button>
            <div className="flex gap-2">
              {stepIndex > 0 && (
                <Button variant="outline" size="sm" onClick={prev}>
                  Retour
                </Button>
              )}
              <Button size="sm" onClick={next}>
                {stepIndex === steps.length - 1 ? 'Terminer' : 'Suivant'}
                {stepIndex < steps.length - 1 && <ArrowRight className="w-3 h-3 ml-1" />}
              </Button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
