// ─── Purama · Motion presets (framer-motion) ─────────────────────────────

import type { Transition, Variants } from 'framer-motion';

export const puramaSpring = {
  gentle: { type: 'spring', stiffness: 170, damping: 26, mass: 1 } as Transition,
  bouncy: { type: 'spring', stiffness: 400, damping: 20, mass: 1 } as Transition,
  snappy: { type: 'spring', stiffness: 500, damping: 40, mass: 1 } as Transition,
  smooth: { type: 'spring', stiffness: 200, damping: 30, mass: 1 } as Transition,
  wobbly: { type: 'spring', stiffness: 300, damping: 14, mass: 1 } as Transition,
};

export const fadeIn: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: puramaSpring.gentle },
  exit: { opacity: 0, y: -8, transition: { duration: 0.15 } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: puramaSpring.smooth },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.15 } },
};

export const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
};

export const hoverLift = { scale: 1.02, y: -2, transition: puramaSpring.snappy };
export const hoverPress = { scale: 0.98, transition: puramaSpring.snappy };
