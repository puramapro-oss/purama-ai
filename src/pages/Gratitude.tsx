import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Heart, Plus, Calendar, Flame, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAwakening } from '@/hooks/useAwakening';
import { toast } from 'sonner';

interface GratitudeEntry {
  id: string;
  text: string;
  date: string;
  createdAt: string;
}

const STORAGE_KEY = 'purama_gratitude';
const MAX_PER_DAY = 3;

function getEntries(): GratitudeEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveEntries(entries: GratitudeEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

export default function Gratitude() {
  const { recordGratitude, streak } = useAwakening();
  const [entries, setEntries] = useState<GratitudeEntry[]>(getEntries);
  const [newText, setNewText] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  const today = getToday();
  const todayEntries = useMemo(() => entries.filter(e => e.date === today), [entries, today]);
  const canAddMore = todayEntries.length < MAX_PER_DAY;

  const handleAdd = () => {
    if (!newText.trim()) return;
    if (!canAddMore) {
      toast.info(`Maximum ${MAX_PER_DAY} gratitudes par jour`);
      return;
    }

    const entry: GratitudeEntry = {
      id: crypto.randomUUID(),
      text: newText.trim(),
      date: today,
      createdAt: new Date().toISOString(),
    };

    const updated = [entry, ...entries];
    setEntries(updated);
    saveEntries(updated);
    setNewText('');
    setIsAdding(false);
    recordGratitude();
    toast.success('+30 XP eveil');
  };

  const handleDelete = (id: string) => {
    const updated = entries.filter(e => e.id !== id);
    setEntries(updated);
    saveEntries(updated);
  };

  const groupedByDate = useMemo(() => {
    const groups: Record<string, GratitudeEntry[]> = {};
    for (const entry of entries) {
      if (!groups[entry.date]) groups[entry.date] = [];
      groups[entry.date].push(entry);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [entries]);

  const formatDate = (dateStr: string) => {
    if (dateStr === today) return "Aujourd'hui";
    const d = new Date(dateStr);
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-3">
            <Heart className="w-7 h-7 text-accent-pink" />
            Journal de gratitude
          </h1>
          <p className="text-muted-foreground mt-1">3 gratitudes par jour transforment ta vision du monde</p>
        </div>
        {streak > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-orange-500/10 text-orange-400 text-sm font-medium">
            <Flame className="w-4 h-4" />
            {streak}j
          </div>
        )}
      </div>

      {/* Today progress */}
      <Card className="bg-gradient-to-br from-accent-pink/10 to-accent-purple/10 border-accent-pink/20">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-foreground">Aujourd'hui</span>
            <span className="text-sm text-muted-foreground">{todayEntries.length}/{MAX_PER_DAY}</span>
          </div>
          <div className="flex gap-2 mb-4">
            {Array.from({ length: MAX_PER_DAY }).map((_, i) => (
              <div
                key={i}
                className={`flex-1 h-2 rounded-full transition-all duration-300 ${
                  i < todayEntries.length ? 'bg-gradient-to-r from-accent-pink to-accent-purple' : 'bg-white/10'
                }`}
              />
            ))}
          </div>
          {canAddMore && !isAdding && (
            <Button onClick={() => setIsAdding(true)} className="w-full btn-primary">
              <Plus className="w-4 h-4 mr-2" />
              Ajouter une gratitude
            </Button>
          )}
          {!canAddMore && (
            <p className="text-center text-sm text-accent-emerald font-medium">
              Tu as complete tes 3 gratitudes du jour !
            </p>
          )}
        </CardContent>
      </Card>

      {/* Add form */}
      <AnimatePresence>
        {isAdding && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <Card className="bg-card/50 border-border">
              <CardContent className="pt-6 space-y-4">
                <label className="text-sm font-medium text-foreground block">
                  Pour quoi es-tu reconnaissant aujourd'hui ?
                </label>
                <textarea
                  value={newText}
                  onChange={e => setNewText(e.target.value)}
                  placeholder="Je suis reconnaissant pour..."
                  className="w-full h-24 bg-secondary/50 border border-border rounded-xl p-3 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-2 focus:ring-accent-purple/50"
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button onClick={handleAdd} disabled={!newText.trim()} className="btn-primary flex-1">
                    Enregistrer
                  </Button>
                  <Button onClick={() => { setIsAdding(false); setNewText(''); }} variant="outline">
                    Annuler
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Entries */}
      {groupedByDate.length === 0 ? (
        <Card className="bg-card/50 border-border">
          <CardContent className="pt-6 text-center py-12">
            <Heart className="w-12 h-12 text-muted-foreground/20 mx-auto mb-3" />
            <p className="text-muted-foreground">L'espace de toutes les possibilites</p>
            <p className="text-sm text-muted-foreground/60 mt-1">Commence par ta premiere gratitude</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {groupedByDate.map(([date, dateEntries]) => (
            <div key={date}>
              <div className="flex items-center gap-2 mb-3">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium text-muted-foreground">{formatDate(date)}</span>
              </div>
              <div className="space-y-2">
                {dateEntries.map((entry, i) => (
                  <motion.div
                    key={entry.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                  >
                    <Card className="bg-card/50 border-border group">
                      <CardContent className="py-3 px-4 flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <Heart className="w-4 h-4 text-accent-pink mt-0.5 shrink-0" />
                          <p className="text-sm text-foreground/80">{entry.text}</p>
                        </div>
                        <button
                          onClick={() => handleDelete(entry.id)}
                          className="text-muted-foreground/30 hover:text-destructive transition-colors shrink-0 opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
