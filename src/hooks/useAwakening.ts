import { useCallback, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { localJournalDate } from '@/lib/gratitude-journal';

interface ActivityState {
  owner: string;
  affirmationsSeen: number;
  breathSessions: number;
  gratitudeEntries: number;
  lastAffirmation: string | null;
  lastActiveDate: string | null;
}

type Activity = 'affirmationsSeen' | 'breathSessions' | 'gratitudeEntries';

const LEVELS = [{ name: 'Activités choisies', minXp: 0 }] as const;

function emptyActivity(owner: string): ActivityState {
  return { owner, affirmationsSeen: 0, breathSessions: 0, gratitudeEntries: 0, lastAffirmation: null, lastActiveDate: null };
}

export function useAwakening() {
  const { user } = useAuth();
  const owner = user?.id ?? 'anonymous';
  const activeOwner = useRef(owner);
  activeOwner.current = owner;
  const [stored, setStored] = useState<ActivityState>(() => emptyActivity(owner));
  const state = stored.owner === owner ? stored : emptyActivity(owner);

  // These counters describe voluntary actions in the current mounted session.
  // They never measure spirituality, health, worth, wallet credit or quota.
  // No localStorage, remote write, streak penalty or background collection.
  const record = useCallback((activity: Activity) => {
    if (activeOwner.current !== owner) return;
    setStored(previous => {
      const current = previous.owner === owner ? previous : emptyActivity(owner);
      const today = localJournalDate();
      return {
        ...current,
        [activity]: current[activity] + 1,
        lastActiveDate: today,
        lastAffirmation: activity === 'affirmationsSeen' ? today : current.lastAffirmation,
      };
    });
  }, [owner]);

  const recordAffirmation = useCallback(() => record('affirmationsSeen'), [record]);
  const recordBreathSession = useCallback(() => record('breathSessions'), [record]);
  const recordGratitude = useCallback(() => record('gratitudeEntries'), [record]);
  // Keep the historical hook shape for callers. These legacy progression fields
  // are inert; activity must not award a moral or spiritual rank.
  const addXp = useCallback((amount: number) => { void amount; }, []);

  return {
    ...state,
    level: 1,
    xp: 0,
    streak: 0,
    currentLevelName: LEVELS[0].name,
    nextLevelName: null,
    progressToNext: 0,
    addXp,
    recordAffirmation,
    recordBreathSession,
    recordGratitude,
    levels: LEVELS,
  };
}
