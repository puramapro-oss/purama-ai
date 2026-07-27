import { Activity } from 'lucide-react';
import { useWeeklyActionsCount } from '@/hooks/usePublicStats';

/** Preuve sociale automatique en home — brief PRICING & OFFRE IRRÉSISTIBLE. Rendu discret, aucun
 * skeleton infini : masqué tant que le chiffre réel n'est pas chargé. */
export function PublicActionsCounter() {
  const { data: count, isLoading } = useWeeklyActionsCount();

  if (isLoading || count === undefined) return null;

  return (
    <div className="flex justify-center py-4">
      <div className="inline-flex items-center gap-2 glass-effect px-4 py-2 rounded-full text-sm text-foreground/80">
        <Activity className="w-4 h-4 text-accent-cyan" />
        <span>
          <strong className="text-foreground">{count.toLocaleString('fr-FR')}</strong> action
          {count > 1 ? 's' : ''} exécutée{count > 1 ? 's' : ''} par nos employés IA cette semaine
        </span>
      </div>
    </div>
  );
}
