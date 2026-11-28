import { useState } from 'react';
import { Button } from '@/components/ui/button';
import missions from '@/lib/organization-missions.json';

const families = [...new Set(missions.map(mission => mission.family))];
const selectClass = 'mt-1 block w-full rounded-md border border-input bg-background p-2 text-sm';

export interface OrganizationMissionDraft {
  name: string;
  description: string;
  system_prompt: string;
}

export function OrganizationMissionPicker({ disabled, onApply }: {
  disabled: boolean;
  onApply: (mission: OrganizationMissionDraft) => void;
}) {
  const [profile, setProfile] = useState('entreprise');
  const [family, setFamily] = useState(families[0]);
  const options = missions.filter(mission => mission.family === family);
  const [selection, setSelection] = useState<number | null>(null);
  const mission = options.find(option => option.id === selection);
  const profileBrief = profile === 'association'
    ? 'Précise la mission associative, les bénéficiaires, les rôles des membres et bénévoles, les fonds affectés et la personne mandatée pour valider.'
    : 'Précise le besoin du client, le responsable, les coûts à prendre en charge et la personne mandatée pour valider.';
  return (
    <details className="rounded-lg border border-border p-4" open>
      <summary className="cursor-pointer font-semibold">Modèles de mission pour une organisation</summary>
      <div className="mt-3 space-y-3">
        <label className="block text-sm">Contexte de la mission
          <select className={selectClass} value={profile} onChange={event => setProfile(event.target.value)}>
            <option value="entreprise">Entreprise</option>
            <option value="association">Association</option>
          </select>
        </label>
        <label className="block text-sm">Domaine
          <select className={selectClass} value={family} onChange={event => {
            setFamily(event.target.value);
            setSelection(null);
          }}>
            {families.map(value => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label className="block text-sm">Mission
          <select className={selectClass} value={selection ?? ''} onChange={event => {
            setSelection(event.target.value ? Number(event.target.value) : null);
          }}>
            <option value="">Choisir une mission</option>
            {options.map(option => <option key={option.id} value={option.id}>{option.title}</option>)}
          </select>
        </label>
        {mission && <p className="text-sm">{mission.acceptance}</p>}
        <Button type="button" variant="outline" disabled={disabled || !mission} onClick={() => {
          if (!mission || disabled) return;
          onApply({
            name: mission.title,
            description: mission.acceptance,
            system_prompt: [
              'Prépare la mission « ' + mission.title + ' ».',
              profileBrief,
              'Clarifie le périmètre, les sources autorisées et les données confidentielles de cette organisation.',
              'Critère de réception à adapter avec le responsable : ' + mission.acceptance,
              'Teste le livrable sur un échantillon, relève les écarts, propose une correction et vérifie son résultat avant la remise.',
              'Une décision externe, un changement de droits ou un engagement financier exige le mandat correspondant.',
            ].join('\n'),
          });
        }}>Préparer ce brouillon</Button>
        {disabled && <p className="text-xs text-muted-foreground">Ce modèle s’applique à un brouillon vide et disponible.</p>}
      </div>
    </details>
  );
}
