import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Mail, Eye, MousePointerClick, Reply, AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { listEmails, type PartnerEmail } from '@/lib/partner';

const TYPE_LABEL: Record<string, string> = {
  outreach: 'Outreach',
  relance_1: 'Relance 1',
  relance_2: 'Relance 2',
  relance_3: 'Relance 3',
  contract: 'Contrat',
  welcome: 'Bienvenue',
  custom: 'Custom',
  reply: 'Réponse',
};

export default function PartnerAgentEmails() {
  const { user } = useAuth();
  const [emails, setEmails] = useState<PartnerEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PartnerEmail | null>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try { setEmails(await listEmails(user.id)); }
      catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
      finally { setLoading(false); }
    })();
  }, [user?.id]);

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>;
  }

  // Compute global metrics
  const sent = emails.filter(e => e.sent_at);
  const opens = sent.filter(e => e.opened).length;
  const clicks = sent.filter(e => e.clicked).length;
  const replies = sent.filter(e => e.replied).length;
  const openRate = sent.length > 0 ? Math.round((opens / sent.length) * 100) : 0;
  const clickRate = sent.length > 0 ? Math.round((clicks / sent.length) * 100) : 0;
  const replyRate = sent.length > 0 ? Math.round((replies / sent.length) * 100) : 0;

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/dashboard/partner-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
          <Mail className="w-6 h-6 text-accent-cyan" /> Emails de prospection
        </h1>
      </motion.div>

      {/* Global metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric label="Envoyés" value={sent.length.toString()} icon={Mail} color="text-accent-cyan" />
        <Metric label="Ouverture" value={`${openRate}%`} icon={Eye} color="text-yellow-400" />
        <Metric label="Clics" value={`${clickRate}%`} icon={MousePointerClick} color="text-emerald-400" />
        <Metric label="Réponses" value={`${replyRate}%`} icon={Reply} color="text-accent-purple" />
      </div>

      {emails.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucun email envoyé.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {emails.map(e => (
            <button
              key={e.id}
              onClick={() => setSelected(e)}
              className="w-full text-left flex items-start gap-3 p-4 rounded-lg border border-border bg-card hover:bg-secondary/30 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-accent-cyan/10 flex items-center justify-center flex-shrink-0">
                <Mail className="w-5 h-5 text-accent-cyan" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium text-foreground truncate">{e.subject}</p>
                  <Badge variant="outline" className="text-[10px] py-0 h-4">{TYPE_LABEL[e.type] ?? e.type}</Badge>
                  {e.opened && <Eye className="w-3 h-3 text-yellow-400" />}
                  {e.clicked && <MousePointerClick className="w-3 h-3 text-emerald-400" />}
                  {e.replied && <Reply className="w-3 h-3 text-accent-purple" />}
                  {e.bounced && <AlertCircle className="w-3 h-3 text-red-400" />}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {e.sent_at ? `Envoyé le ${new Date(e.sent_at).toLocaleString('fr-FR')}` : `Brouillon · ${new Date(e.created_at).toLocaleString('fr-FR')}`}
                </p>
              </div>
              <Badge className={`text-[10px] flex-shrink-0 ${e.status === 'sent' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-secondary text-muted-foreground'}`}>
                {e.status}
              </Badge>
            </button>
          ))}
        </div>
      )}

      {/* Detail */}
      {selected && (
        <div className="fixed inset-0 z-[10000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="bg-card border border-border rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-border">
              <p className="text-xs text-muted-foreground mb-1">{TYPE_LABEL[selected.type] ?? selected.type}</p>
              <h3 className="text-lg font-semibold text-foreground">{selected.subject}</h3>
            </div>
            <div className="p-5 prose prose-sm prose-invert max-w-none" dangerouslySetInnerHTML={{ __html: selected.body_html }} />
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, icon: Icon, color }: { label: string; value: string; icon: typeof Mail; color: string }) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4">
        <Icon className={`w-4 h-4 ${color} mb-2`} />
        <p className="text-xl font-orbitron font-bold text-foreground">{value}</p>
        <p className="text-[11px] text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}
