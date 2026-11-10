import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Plug, Unlink, Loader2, Sparkles, ExternalLink, Globe2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  ALL_PLATFORMS,
  PLATFORM_META,
  type Platform,
  type SocialAccount,
  type AutopilotConfig,
  type SocialPublication,
  listAccounts,
  listPublications,
  getConnectUrl,
  disconnectAccount,
  getAutopilotConfig,
  updateAutopilotConfig,
} from '@/lib/social';
import { publicationLabel } from '@/lib/social-publish-request';

export default function SocialSettings() {
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [config, setConfig] = useState<AutopilotConfig | null>(null);
  const [publications, setPublications] = useState<SocialPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyPlatform, setBusyPlatform] = useState<Platform | null>(null);

  const refresh = useCallback(async (): Promise<SocialAccount[]> => {
    setLoading(true);
    try {
      const [acc, cfg, posts] = await Promise.all([listAccounts(), getAutopilotConfig(), listPublications()]);
      setAccounts(acc ?? []);
      setConfig(cfg);
      setPublications(posts ?? []);
      return acc ?? [];
    } catch (e) {
      toast.error('Erreur de chargement', {
        description: e instanceof Error ? e.message : String(e),
      });
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Show toast on OAuth callback redirect
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const error = params.get('error');
    const callbackStatus = params.get('status');
    void refresh().then((freshAccounts) => {
      if (!connected) return;
      if (freshAccounts.some((account) => account.platform === connected && account.is_active && account.publishing_verified_at && !account.disconnect_pending)) {
        toast.success(`${PLATFORM_META[connected as Platform]?.label ?? connected} connecté`);
      } else {
        toast.warning('Connexion à vérifier', { description: 'Ce compte n’est pas encore confirmé dans la liste.' });
      }
    });
    if (callbackStatus === 'cancelled') toast.info('Connexion annulée', { description: 'Aucune nouvelle connexion n’a été activée.' });
    if (callbackStatus === 'already_processed') toast.info('Demande déjà traitée', { description: 'La liste affiche l’état actuel de vos comptes.' });
    if (error) {
      toast.error('Connexion impossible', { description: error });
    }
    if (connected || error || callbackStatus) window.history.replaceState({}, '', window.location.pathname);
  }, [refresh]);

  const connectedMap = new Map<Platform, SocialAccount>(
    accounts.map((a) => [a.platform as Platform, a]),
  );

  const handleConnect = async (platform: Platform) => {
    setBusyPlatform(platform);
    try {
      const result = await getConnectUrl(platform);
      const url = result.authUrl || result.url || result.auth_url;
      if (!url) throw new Error("Aucune URL d'authentification reçue");
      const destination = new URL(url);
      if (destination.protocol !== 'https:' || destination.username || destination.password) {
        throw new Error("URL d'authentification invalide");
      }
      window.location.href = url;
    } catch (e) {
      toast.error('Connexion impossible', {
        description: e instanceof Error ? e.message : String(e),
      });
      setBusyPlatform(null);
    }
  };

  const handleDisconnect = async (platform: Platform) => {
    setBusyPlatform(platform);
    try {
      const result = await disconnectAccount(platform);
      if (result.success && result.provider_disconnected) {
        toast.success(`${PLATFORM_META[platform].label} déconnecté`);
      } else {
        toast.warning('Déconnexion à confirmer', {
          description: result.message || 'Publication désactivée dans PURAMA ; déconnexion du fournisseur à confirmer.',
        });
      }
      await refresh();
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyPlatform(null);
    }
  };

  const updateConfig = async (patch: Partial<AutopilotConfig>) => {
    if (!config) return;
    const optimistic = { ...config, ...patch };
    setConfig(optimistic);
    try {
      const updated = await updateAutopilotConfig(patch);
      setConfig(updated);
    } catch (e) {
      toast.error('Échec sauvegarde', { description: e instanceof Error ? e.message : String(e) });
      try { setConfig(await getAutopilotConfig()); } catch { setConfig(config); }
    }
  };

  return (
    <div className="space-y-10 max-w-5xl mx-auto">
      {/* Hero */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent-cyan to-accent-purple flex items-center justify-center">
            <Globe2 className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-orbitron font-bold text-foreground">
              Mes réseaux sociaux
            </h1>
            <p className="text-sm text-muted-foreground">
              Connecte et vérifie tes comptes pour publier le contenu préparé avec PURAMA. Les formats et droits dépendent de chaque réseau.
            </p>
          </div>
        </div>
      </div>

      {/* Platforms grid */}
      <section>
        <h2 className="text-lg font-orbitron font-semibold text-foreground mb-4">
          Connexions aux réseaux
        </h2>
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {ALL_PLATFORMS.map((platform, idx) => {
              const meta = PLATFORM_META[platform];
              const account = connectedMap.get(platform);
              const isConnected = account?.is_active === true && !!account.publishing_verified_at && !account.disconnect_pending;
              const disconnectPending = account?.disconnect_pending === true;
              const isBusy = busyPlatform === platform;
              return (
                <motion.div
                  key={platform}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.04 }}
                >
                  <Card
                    className={`relative overflow-hidden border ${
                      isConnected
                        ? 'border-accent-cyan/40 bg-card'
                        : 'border-border bg-card/60'
                    } transition-all hover:scale-[1.01] hover:border-accent-purple/50`}
                  >
                    <div
                      className="absolute inset-0 opacity-10 pointer-events-none"
                      style={{
                        background: `linear-gradient(135deg, ${meta.color}55, transparent)`,
                      }}
                    />
                    <CardContent className="p-5 space-y-4 relative">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
                            style={{ background: `${meta.color}22`, border: `1px solid ${meta.color}55` }}
                          >
                            {meta.emoji}
                          </div>
                          <div>
                            <h3 className="font-orbitron font-semibold text-foreground">
                              {meta.label}
                            </h3>
                            <p className="text-xs text-muted-foreground">{meta.description}</p>
                          </div>
                        </div>
                        {isConnected && (
                          <span className="text-xs px-2 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/30">
                            ✓ Connecté
                          </span>
                        )}
                      </div>

                      {account && (account.account_name || account.account_username) && (
                        <div className="text-xs text-muted-foreground truncate">
                          {account.account_username || account.account_name}
                        </div>
                      )}

                      {account && !isConnected && (
                        <p className="text-xs text-amber-500">
                          {disconnectPending ? 'Déconnexion en attente de confirmation.' : account.is_active ? 'Compte à vérifier avant publication.' : 'Publication désactivée.'}
                        </p>
                      )}
                      {platform === 'twitter' && (
                        <p className="text-xs text-amber-500">Publication X suspendue : financement à vérifier côté serveur.</p>
                      )}
                      <div className="flex justify-end gap-2 flex-wrap">
                        {account && (account.is_active || disconnectPending || !account.disconnect_completed_at) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDisconnect(platform)}
                            disabled={isBusy}
                            className="border-border text-muted-foreground hover:text-red-400 hover:border-red-400/50"
                          >
                            {isBusy ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <>
                                <Unlink className="w-4 h-4 mr-1" /> {disconnectPending || !account.is_active ? 'Vérifier la déconnexion' : 'Déconnecter'}
                              </>
                            )}
                          </Button>
                        )}
                        {!isConnected && !disconnectPending && (
                          <Button
                            size="sm"
                            onClick={() => handleConnect(platform)}
                            disabled={isBusy || platform === 'twitter'}
                            className="bg-gradient-to-r from-accent-cyan to-accent-purple text-primary-foreground"
                          >
                            {isBusy ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <>
                                <Plug className="w-4 h-4 mr-1" /> Connecter
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        )}
      </section>

      {/* Autopilot section */}
      <section>
        <Card className="bg-card border-accent-purple/30">
          <CardContent className="p-6 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-purple to-accent-cyan flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-orbitron font-bold text-foreground">
                  Autopilot
                </h2>
                <p className="text-xs text-muted-foreground">
                  Transmet le contenu préparé par les agents participants aux comptes vérifiés, puis suit la confirmation du fournisseur.
                </p>
              </div>
            </div>

            {!config ? (
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            ) : (
              <div className="space-y-4">
                <ToggleRow
                  label="Activer l'autopilot"
                  description="Envoyer automatiquement le contenu préparé vers les destinations choisies."
                  checked={config.autopilot_enabled}
                  onChange={(v) => updateConfig({ autopilot_enabled: v })}
                />
                <p className="text-xs text-muted-foreground">Le texte et les hashtags déjà préparés sont conservés. La publication ne déclenche aucune génération IA payante supplémentaire.</p>

                <div className="pt-2">
                  <p className="text-xs text-muted-foreground mb-2">
                    Plateformes par défaut (si non spécifiées par l'agent)
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ALL_PLATFORMS.map((p) => {
                      const active = config.default_platforms?.includes(p);
                      return (
                        <button
                          key={p}
                          disabled={p === 'twitter' && !active}
                          type="button"
                          onClick={() => {
                            const next = active
                              ? config.default_platforms.filter((x) => x !== p)
                              : [...(config.default_platforms || []), p];
                            updateConfig({ default_platforms: next });
                          }}
                          className={`px-3 py-1 rounded-full text-xs border transition-all ${
                            active
                              ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan'
                              : 'bg-secondary/40 border-border text-muted-foreground hover:border-accent-purple/50'
                          }`}
                        >
                          {PLATFORM_META[p].emoji} {PLATFORM_META[p].label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="publication-history-title" className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 id="publication-history-title" className="text-lg font-orbitron font-semibold">Historique des publications</h2>
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>Actualiser</Button>
        </div>
        <p className="text-xs text-muted-foreground">Les 50 dernières demandes. Une publication à confirmer n'est jamais renvoyée automatiquement.</p>
        {!loading && publications.length === 0 && <p className="text-sm text-muted-foreground">Aucune demande enregistrée.</p>}
        <div className="space-y-3">
          {publications.map((publication) => (
            <Card key={publication.id}>
              <CardContent className="p-4 space-y-2">
                <div className="flex justify-between gap-4 text-sm">
                  <strong>{publication.status === 'draft' ? 'Brouillon' : publication.status === 'publishing' ? 'Publication à confirmer' : publicationLabel(publication.status)}</strong>
                  <time className="text-xs text-muted-foreground" dateTime={publication.created_at}>{new Date(publication.created_at).toLocaleString('fr-FR')}</time>
                </div>
                <p className="text-sm whitespace-pre-wrap break-words line-clamp-3">{publication.content_text || 'Publication avec média'}</p>
                <p className="text-xs text-muted-foreground">{publication.target_platforms.map((platform) => PLATFORM_META[platform as Platform]?.label ?? platform).join(', ')}</p>
                {publication.error_message && <p className="text-xs text-amber-500">{publication.error_message}</p>}
                {Array.isArray(publication.platform_results) && publication.platform_results.length > 0 && (
                  <ul aria-label="Résultat par réseau" className="text-xs text-muted-foreground">
                    {publication.platform_results.map((result, index) => (
                      <li key={`${result.platform}-${result.accountId}-${index}`}>{PLATFORM_META[result.platform as Platform]?.label ?? result.platform} : {result.status === 'published' ? 'publié' : result.status === 'failed' ? 'échec confirmé' : 'à confirmer'}</li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <p className="text-xs text-muted-foreground text-center">
        Connexions gérées avec Zernio. L'abonnement du fournisseur et les droits des plateformes doivent être configurés.{' '}
        <a
          href="https://zernio.com"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:text-accent-cyan"
        >
          En savoir plus <ExternalLink className="w-3 h-3" />
        </a>
      </p>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-4 rounded-xl bg-secondary/30 border border-border">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
