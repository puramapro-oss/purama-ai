import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'purama_awakening';

interface AwakeningState {
  level: number;
  xp: number;
  affirmationsSeen: number;
  breathSessions: number;
  gratitudeEntries: number;
  lastAffirmation: string | null;
  streak: number;
  lastActiveDate: string | null;
}

const LEVELS = [
  { name: 'Eveille', minXp: 0 },
  { name: 'Conscient', minXp: 500 },
  { name: 'Aligne', minXp: 1500 },
  { name: 'Illumine', minXp: 4000 },
  { name: 'Transcendant', minXp: 10000 },
  { name: 'Unifie', minXp: 25000 },
] as const;

const DEFAULT_STATE: AwakeningState = {
  level: 1,
  xp: 0,
  affirmationsSeen: 0,
  breathSessions: 0,
  gratitudeEntries: 0,
  lastAffirmation: null,
  streak: 0,
  lastActiveDate: null,
};

function getLevelFromXp(xp: number): number {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEVELS[i].minXp) return i + 1;
  }
  return 1;
}

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

export function useAwakening() {
  const [state, setState] = useState<AwakeningState>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as AwakeningState;
        const today = getToday();
        const lastActive = parsed.lastActiveDate;
        if (lastActive && lastActive !== today) {
          const last = new Date(lastActive);
          const now = new Date(today);
          const diffDays = Math.floor((now.getTime() - last.getTime()) / 86400000);
          if (diffDays === 1) {
            parsed.streak += 1;
          } else if (diffDays > 1) {
            parsed.streak = 0;
          }
          parsed.lastActiveDate = today;
        } else if (!lastActive) {
          parsed.lastActiveDate = today;
        }
        parsed.level = getLevelFromXp(parsed.xp);
        return parsed;
      }
    } catch { /* ignore */ }
    return { ...DEFAULT_STATE, lastActiveDate: getToday() };
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const addXp = useCallback((amount: number) => {
    setState(prev => {
      const newXp = prev.xp + amount;
      return { ...prev, xp: newXp, level: getLevelFromXp(newXp) };
    });
  }, []);

  const recordAffirmation = useCallback(() => {
    setState(prev => ({ ...prev, affirmationsSeen: prev.affirmationsSeen + 1 }));
    addXp(20);
  }, [addXp]);

  const recordBreathSession = useCallback(() => {
    setState(prev => ({ ...prev, breathSessions: prev.breathSessions + 1 }));
    addXp(50);
  }, [addXp]);

  const recordGratitude = useCallback(() => {
    setState(prev => ({ ...prev, gratitudeEntries: prev.gratitudeEntries + 1 }));
    addXp(30);
  }, [addXp]);

  const currentLevel = LEVELS[state.level - 1] || LEVELS[0];
  const nextLevel = LEVELS[state.level] || null;
  const progressToNext = nextLevel
    ? ((state.xp - currentLevel.minXp) / (nextLevel.minXp - currentLevel.minXp)) * 100
    : 100;

  return {
    ...state,
    currentLevelName: currentLevel.name,
    nextLevelName: nextLevel?.name || null,
    progressToNext: Math.min(100, Math.max(0, progressToNext)),
    addXp,
    recordAffirmation,
    recordBreathSession,
    recordGratitude,
    levels: LEVELS,
  };
}
