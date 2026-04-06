import { useEffect, useState } from 'react';
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
  listAccounts,
  getConnectUrl,
  disconnectAccount,
  getAutopilotConfig,
  updateAutopilotConfig,
} from '@/lib/social';

export default function SocialSettings() {
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [config, setConfig] = useState<AutopilotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyPlatform, setBusyPlatform] = useState<Platform | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [acc, cfg] = await Promise.all([listAccounts(), getAutopilotConfig()]);
      setAccounts(acc ?? []);
      setConfig(cfg);
    } catch (e) {
      toast.error('Erreur de chargement', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();

    // Show toast on OAuth callback redirect
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const error = params.get('error');
    if (connected) {
      toast.success(`✅ ${PLATFORM_META[connected as Platform]?.label ?? connected} connecté !`);
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (error) {
      toast.error('Connexion impossible', { description: error });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const connectedMap = new Map<Platform, SocialAccount>(
    accounts.map((a) => [a.platform as Platform, a]),
  );

  const handleConnect = async (platform: Platform) => {
    setBusyPlatform(platform);
    try {
      const result = await getConnectUrl(platform);
      const url = (result as { url?: string; auth_url?: string }).url
        || (result as { auth_url?: string }).auth_url;
      if (!url) throw new Error("Aucune URL d'authentification reçue");
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
      await disconnectAccount(platform);
      toast.success(`${PLATFORM_META[platform].label} déconnecté`);
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
      setConfig(config);
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
              Connecte tes comptes : tout contenu généré par les agents PURAMA AI peut être publié partout en un clic.
            </p>
          </div>
        </div>
      </div>

      {/* Platforms grid */}
      <section>
        <h2 className="text-lg font-orbitron font-semibold text-foreground mb-4">
          14 plateformes supportées
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
              const isConnected = !!account;
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

                      {isConnected && account.account_name && (
                        <div className="text-xs text-muted-foreground truncate">
                          {account.account_username || account.account_name}
                        </div>
                      )}

                      <div className="flex justify-end">
                        {isConnected ? (
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
                                <Unlink className="w-4 h-4 mr-1" /> Déconnecter
                              </>
                            )}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => handleConnect(platform)}
                            disabled={isBusy}
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
                  Publie automatiquement tout contenu généré par les agents PURAMA AI sur tes réseaux connectés.
                </p>
              </div>
            </div>

            {!config ? (
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            ) : (
              <div className="space-y-4">
                <ToggleRow
                  label="Activer l'autopilot"
                  description="Tout contenu généré par un agent IA est publié automatiquement."
                  checked={config.autopilot_enabled}
                  onChange={(v) => updateConfig({ autopilot_enabled: v })}
                />
                <ToggleRow
                  label="Caption IA automatique"
                  description="Claude réécrit la caption pour maximiser l'engagement."
                  checked={config.auto_caption}
                  onChange={(v) => updateConfig({ auto_caption: v })}
                />
                <ToggleRow
                  label="Hashtags automatiques"
                  description="Génère 5-10 hashtags pertinents par publication."
                  checked={config.auto_hashtags}
                  onChange={(v) => updateConfig({ auto_hashtags: v })}
                />

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

      <p className="text-xs text-muted-foreground text-center">
        Propulsé par Zernio — 14 plateformes, 1 API.{' '}
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
