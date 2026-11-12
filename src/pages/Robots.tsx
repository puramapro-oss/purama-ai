import { useState } from 'react';
import { Bot, ExternalLink, MonitorPlay, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RobotRehearsal } from '@/components/robotics/RobotRehearsal';
import { listRobotTargets } from '../../karta/src/robotics/catalog';
import { getRobotConnectionGuide } from '../../karta/src/robotics/connectionGuide';

const targets = listRobotTargets();

export default function Robots() {
  const [targetId, setTargetId] = useState('tesla-optimus');
  const guide = getRobotConnectionGuide(targetId);
  const simulation = guide.status === 'simulation_available';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-accent-cyan">PURAMA · Robots</p>
        <h1 className="text-3xl font-semibold tracking-tight">Vos robots, avec PURAMA</h1>
        <p className="text-muted-foreground max-w-2xl">Choisissez votre modèle pour connaître son mode d'accès, puis préparez une séance dans le simulateur.</p>
        <p className="text-sm text-muted-foreground">{targets.filter(target => target.stage !== 'simulator').length} modèles étudiés · Aucun robot connecté</p>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section aria-labelledby="robot-choice-title" className="rounded-2xl border border-border bg-card p-5 sm:p-6 space-y-5">
          <h2 id="robot-choice-title" className="text-lg font-semibold flex items-center gap-2"><Bot className="h-5 w-5" />1. Choisir votre modèle</h2>
          <div className="space-y-2">
            <label htmlFor="robot-target" className="text-sm font-medium">Modèle de robot</label>
            <select id="robot-target" value={targetId} onChange={event => setTargetId(event.target.value)} className="w-full min-w-0 rounded-lg border border-input bg-background p-3 text-sm">
              {targets.map(target => <option key={target.id} value={target.id}>{target.manufacturer} — {target.model}</option>)}
            </select>
          </div>
          <div role="status" className="rounded-xl bg-secondary/40 p-4 space-y-2">
            <p className="font-medium">{simulation ? 'Simulateur disponible' : 'Connexion matérielle à préparer'}</p>
            <p className="text-sm text-muted-foreground">{guide.phone}</p>
          </div>
          <div className="space-y-2">
            <h3 className="font-medium text-sm">Disponible dans PURAMA pour ce choix</h3>
            <dl className="divide-y divide-border text-sm">
              {guide.capabilities.map(capability => <div key={capability.name} className="flex justify-between gap-3 py-2">
                <dt>{capability.name}</dt><dd className={capability.availability === 'preview' ? 'text-accent-cyan' : 'text-muted-foreground'}>{capability.availability === 'preview' ? 'Aperçu visuel' : 'Non raccordé'}</dd>
              </div>)}
            </dl>
          </div>
        </section>

        <section aria-labelledby="robot-access-title" className="rounded-2xl border border-border bg-card p-5 sm:p-6 space-y-5">
          <h2 id="robot-access-title" className="text-lg font-semibold flex items-center gap-2"><Radio className="h-5 w-5" />2. Comprendre l'accès</h2>
          <p className="font-medium">{guide.method}</p>
          <ol className="space-y-4 list-decimal pl-5 text-sm text-muted-foreground">
            {guide.steps.map(step => <li key={step} className="pl-1">{step}</li>)}
          </ol>
          {!simulation && <>
            <p className="text-sm">Le connecteur PURAMA de ce modèle n'est pas encore disponible. Vous pouvez préparer vos séances dès maintenant.</p>
            <Button onClick={() => setTargetId('purama-simulator')} className="w-full sm:w-auto"><MonitorPlay className="h-4 w-4 mr-2" />Essayer le simulateur</Button>
            <details className="text-sm border-t border-border pt-4">
              <summary className="cursor-pointer font-medium">Sources constructeur · vérifiées le {guide.target.reviewedOn}</summary>
              <p className="my-3 text-muted-foreground">{guide.target.interfaceNote}</p>
              <ul className="space-y-2">
                {guide.target.sources.map((source, index) => <li key={source}><a href={source} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-accent-cyan underline underline-offset-4">Documentation {index + 1}<ExternalLink className="h-3 w-3" /></a></li>)}
              </ul>
            </details>
          </>}
        </section>
      </div>

      {simulation && <RobotRehearsal />}
      <p className="text-xs text-muted-foreground">Les capacités physiques dépendent du modèle, de ses accessoires et des accès accordés par son constructeur. Une formation ne crée pas à elle seule une nouvelle compétence motrice.</p>
    </div>
  );
}
