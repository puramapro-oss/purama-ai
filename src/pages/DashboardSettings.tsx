import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { toast } from 'sonner';
import { Eye, EyeOff, Copy, RefreshCw } from 'lucide-react';
import { VoiceSettingsCard } from '@/components/voice/VoiceSettingsCard';

export default function DashboardSettings() {
  const { user, signOut } = useAuth();
  const { data: profile } = useProfile();
  const [showApiKey, setShowApiKey] = useState(false);
  const apiKey = 'pk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

  return (
    <div className="space-y-8 max-w-2xl">
      <h1 className="text-2xl font-orbitron font-bold text-foreground">Paramètres</h1>

      {/* Profile */}
      <Card className="bg-card border-border">
        <CardContent className="p-6 space-y-4">
          <h3 className="font-orbitron font-semibold text-foreground">Profil</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Nom complet</label>
              <Input defaultValue={profile?.full_name || ''} className="bg-secondary/50 border-border" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Email</label>
              <Input defaultValue={user?.email || ''} disabled className="bg-secondary/30 border-border" />
            </div>
          </div>
          <Button className="bg-gradient-to-r from-accent-cyan to-accent-purple text-primary-foreground" onClick={() => toast.success('Profil sauvegardé')}>
            Sauvegarder
          </Button>
        </CardContent>
      </Card>

      {/* Voice */}
      <VoiceSettingsCard />

      {/* Notifications */}
      <Card className="bg-card border-border">
        <CardContent className="p-6 space-y-4">
          <h3 className="font-orbitron font-semibold text-foreground">Notifications</h3>
          {[
            { label: 'Récap hebdomadaire par email', key: 'weekly' },
            { label: 'Alerte crédits bas', key: 'credits' },
            { label: 'Alerte agent inactif', key: 'inactive' },
          ].map(item => (
            <div key={item.key} className="flex items-center justify-between">
              <span className="text-sm text-foreground/80">{item.label}</span>
              <Switch defaultChecked />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* API Keys */}
      <Card className="bg-card border-border">
        <CardContent className="p-6 space-y-4">
          <h3 className="font-orbitron font-semibold text-foreground">Clé API <span className="text-xs text-muted-foreground font-normal ml-2">(Business uniquement)</span></h3>
          <div className="flex items-center gap-2">
            <Input value={showApiKey ? apiKey : '••••••••••••••••••••••••••••••••'} readOnly className="bg-secondary/30 border-border font-mono text-sm" />
            <Button variant="ghost" size="icon" onClick={() => setShowApiKey(!showApiKey)}>
              {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={() => { navigator.clipboard.writeText(apiKey); toast.success('Clé copiée'); }}>
              <Copy className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => toast.info('Clé régénérée')}>
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Danger Zone */}
      <Card className="bg-card border-destructive/30">
        <CardContent className="p-6">
          <h3 className="font-orbitron font-semibold text-destructive mb-2">Zone de danger</h3>
          <p className="text-sm text-muted-foreground mb-4">La suppression de votre compte est irréversible.</p>
          <Button variant="destructive" onClick={() => toast.error('Veuillez confirmer par email')}>
            Supprimer mon compte
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
