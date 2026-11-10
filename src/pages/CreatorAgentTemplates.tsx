import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Store, Copy, Filter } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ShareButtons } from '@/components/shared/ShareButtons';
import type { PublicCreatorModel } from '@/lib/public-creator-model';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useRequestScope, useScopedState } from '@/hooks/useRequestScope';
import { createRequestScope } from '@/lib/request-scope';
import {
  listTemplates, listPublicAgents, cloneTemplate,
  CATEGORIES,
  type AgentCategory,
} from '@/lib/creator-agent';

export default function CreatorAgentTemplates() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [templates, setTemplates] = useState<PublicCreatorModel[]>([]);
  const [publicAgents, setPublicAgents] = useState<PublicCreatorModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [catalogErrors, setCatalogErrors] = useState({ official: false, community: false });
  const [catalogPending, setCatalogPending] = useState({ official: true, community: true });
  const [filter, setFilter] = useState<'all' | AgentCategory>('all');
  const ownerKey = user?.id ?? 'guest';
  const captureScope = useRequestScope(ownerKey);
  const [cloning, setCloning] = useScopedState<string | null>(ownerKey, null);
  const [copyRequests] = useState(createRequestScope);
  const copyIds = useRef(new Map<string, string>());
  const withdrawnModels = useRef(new Set<string>());

  useLayoutEffect(() => {
    setCloning(null);
    return () => copyRequests.invalidate();
  }, [ownerKey, copyRequests, setCloning]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    // A new load may discover a republication. Within this load, a confirmed
    // withdrawal must survive any older snapshot that arrives afterwards.
    const withdrawn = new Set<string>();
    withdrawnModels.current = withdrawn;
    setLoading(true);
    setCatalogPending({ official: true, community: true });
    setCatalogErrors({ official: false, community: false });
    const load = async (
      kind: 'official' | 'community',
      query: (signal?: AbortSignal) => Promise<PublicCreatorModel[]>,
      update: (models: PublicCreatorModel[]) => void,
    ) => {
      try {
        const models = await query(controller.signal);
        if (active) update(models.filter(model => !withdrawn.has(model.id)));
      } catch {
        if (active) {
          update([]);
          setCatalogErrors(previous => ({ ...previous, [kind]: true }));
        }
      } finally {
        if (active) {
          setCatalogPending(previous => ({ ...previous, [kind]: false }));
          setLoading(false);
        }
      }
    };
    void load('official', listTemplates, setTemplates);
    void load('community', listPublicAgents, setPublicAgents);
    return () => { active = false; controller.abort(); };
  }, [reload]);

  const handleClone = async (tpl: PublicCreatorModel) => {
    if (!user) return;
    const request = copyRequests.begin('copy');
    if (!request) return;
    const isCurrent = captureScope();
    const owner = user.id;
    const key = `${owner}:${tpl.id}`;
    setCloning(tpl.id);
    try {
      let copyId = copyIds.current.get(key);
      if (!copyId) {
        copyId = crypto.randomUUID();
        copyIds.current.set(key, copyId);
      }
      const clone = await cloneTemplate(owner, tpl.id, copyId, request.signal);
      if (!isCurrent() || !request.current()) return;
      toast.success(`✅ ${clone.name} cloné`);
      nav(`/dashboard/creator-agent/${clone.id}`);
    } catch (error) {
      if (isCurrent() && request.current()) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === 'P0002') {
          withdrawnModels.current.add(tpl.id);
          setTemplates(items => items.filter(item => item.id !== tpl.id));
          setPublicAgents(items => items.filter(item => item.id !== tpl.id));
          toast.error('Ce modèle n’est plus disponible.');
        } else {
          toast.error('Copie non confirmée', { description: 'Réessayez pour retrouver la même copie.' });
        }
      }
    } finally {
      if (isCurrent() && request.current()) setCloning(null);
      request.finish();
    }
  };

  const filtered = (list: PublicCreatorModel[]) =>
    filter === 'all' ? list : list.filter(a => a.category === filter);

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/dashboard/creator-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
          <Store className="w-6 h-6 text-yellow-400" /> Marketplace
        </h1>
        <p className="text-sm text-muted-foreground">Templates Purama et agents partagés par la communauté.</p>
      </motion.div>

      <div className="flex items-center gap-2">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <Select value={filter} onValueChange={v => setFilter(v as 'all' | AgentCategory)}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toutes catégories</SelectItem>
            {CATEGORIES.map(c => <SelectItem key={c.value} value={c.value}>{c.emoji} {c.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading && templates.length === 0 && publicAgents.length === 0 ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-purple" /></div>
      ) : (
        <>
          {(catalogErrors.official || catalogErrors.community) && (
            <div className="space-y-3 rounded-lg border border-border bg-card p-4">
              <p role="alert" className="text-sm text-muted-foreground">
                {catalogErrors.official && catalogErrors.community
                  ? 'Le catalogue est temporairement indisponible.'
                  : 'Une partie du catalogue n’a pas pu être chargée. Les modèles disponibles restent accessibles.'}
              </p>
              <Button type="button" variant="outline" onClick={() => setReload(value => value + 1)}>Recharger le catalogue</Button>
            </div>
          )}
          {/* Templates Purama */}
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-3">⭐ Templates officiels Purama</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered(templates).map(t => (
                <TemplateCard key={t.id} agent={t} onClone={() => handleClone(t)} cloning={cloning === t.id} disabled={cloning !== null} />
              ))}
              {catalogPending.official ? (
                <p role="status" className="text-sm text-muted-foreground col-span-full py-4">Chargement des modèles PURAMA…</p>
              ) : catalogErrors.official ? (
                <p className="text-sm text-muted-foreground col-span-full py-4">Modèles PURAMA indisponibles pour le moment.</p>
              ) : filtered(templates).length === 0 && (
                <p className="text-sm text-muted-foreground col-span-full text-center py-8">Aucun template dans cette catégorie.</p>
              )}
            </div>
          </div>

          {/* Public agents */}
          {(publicAgents.length > 0 || catalogErrors.community || catalogPending.community) && (
            <div>
              <h2 className="text-sm font-semibold text-foreground mb-3 mt-8">🌍 Partagés par la communauté</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {catalogPending.community && <p role="status" className="text-sm text-muted-foreground col-span-full py-4">Chargement des modèles de la communauté…</p>}
                {catalogErrors.community && <p className="text-sm text-muted-foreground col-span-full py-4">Modèles de la communauté indisponibles pour le moment.</p>}
                {filtered(publicAgents).map(a => (
                  <TemplateCard key={a.id} agent={a} onClone={() => handleClone(a)} cloning={cloning === a.id} disabled={cloning !== null} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TemplateCard({
  agent, onClone, cloning, disabled,
}: {
  agent: PublicCreatorModel;
  onClone: () => void;
  cloning: boolean;
  disabled: boolean;
}) {
  const cat = CATEGORIES.find(c => c.value === agent.category);
  return (
    <Card
      className="bg-card border-border hover:border-accent-purple/40 transition-all"
      style={{ borderLeftWidth: 3, borderLeftColor: agent.color }}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3 mb-3">
          <div className="text-3xl">{agent.emoji}</div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{agent.name}</p>
            {cat && <Badge variant="outline" className="text-[10px] mt-1">{cat.emoji} {cat.label}</Badge>}
          </div>
        </div>
        {agent.description && (
          <p className="text-[11px] text-muted-foreground line-clamp-3 mb-3">{agent.description}</p>
        )}
        <Button onClick={onClone} disabled={disabled} size="sm" className="w-full">
          {cloning ? <Loader2 className="w-3 h-3 mr-2 animate-spin" /> : <Copy className="w-3 h-3 mr-2" />}
          Cloner
        </Button>
        <div className="mt-3 flex items-start justify-between gap-2 border-t border-border pt-3">
          <Link to={`/modeles/${agent.id}`} className="py-2 text-xs font-medium text-foreground underline underline-offset-4">
            Voir la présentation publique
          </Link>
          <ShareButtons compact path={`/modeles/${agent.id}`} title={`${agent.name} — PURAMA`} text={`Découvrez ${agent.name} sur PURAMA.`} />
        </div>
      </CardContent>
    </Card>
  );
}
