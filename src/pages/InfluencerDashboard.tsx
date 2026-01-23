import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  Users, 
  DollarSign, 
  Link2, 
  Copy, 
  Check, 
  Clock, 
  FileText,
  AlertTriangle,
  RefreshCw,
  TrendingUp,
  CreditCard,
  ArrowLeft,
  Sparkles,
  Download
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { 
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { useAuth } from '@/hooks/useAuth';
import { useInfluencer } from '@/hooks/useInfluencer';
import { useProfile } from '@/hooks/useProfile';
import { formatDistanceToNow, format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { toast } from 'sonner';
import { generateContractPdf } from '@/utils/generateContractPdf';

export default function InfluencerDashboard() {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const { 
    influencer, 
    commissions, 
    isLoading, 
    isExpired,
    registerAsInfluencer,
    regenerateLink,
    signContract,
    updateBankDetails
  } = useInfluencer();
  const navigate = useNavigate();

  const [copied, setCopied] = useState(false);
  const [showContractDialog, setShowContractDialog] = useState(false);
  const [showBankDialog, setShowBankDialog] = useState(false);
  const [registerName, setRegisterName] = useState('');
  const [iban, setIban] = useState('');
  const [beneficiaryName, setBeneficiaryName] = useState('');

  useEffect(() => {
    if (influencer) {
      setIban(influencer.iban || '');
      setBeneficiaryName(influencer.beneficiary_name || '');
    }
  }, [influencer]);

  const copyLink = () => {
    if (influencer?.affiliation_link) {
      navigator.clipboard.writeText(influencer.affiliation_link);
      setCopied(true);
      toast.success('Lien copié !');
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRegister = () => {
    if (!registerName.trim()) {
      toast.error('Veuillez entrer votre nom');
      return;
    }
    registerAsInfluencer.mutate(registerName);
  };

  const handleSignContract = () => {
    signContract.mutate();
    setShowContractDialog(false);
  };

  const handleDownloadContract = () => {
    if (!influencer) return;
    
    generateContractPdf({
      beneficiaryName: influencer.beneficiary_name || 'Affilié',
      promoCode: influencer.promo_code,
      commissionRate: influencer.commission_rate,
      contractSignedAt: influencer.contract_signed_at,
      createdAt: influencer.created_at,
    });
    
    toast.success('Contrat téléchargé !');
  };

  const handleUpdateBank = () => {
    if (!iban || !beneficiaryName) {
      toast.error('Veuillez remplir tous les champs');
      return;
    }
    updateBankDetails.mutate({ iban, beneficiaryName });
    setShowBankDialog(false);
  };

  const pendingCommissions = commissions.filter(c => c.status === 'pending' || c.status === 'validated');
  const paidCommissions = commissions.filter(c => c.status === 'paid');
  const totalPending = pendingCommissions.reduce((sum, c) => sum + Number(c.commission_amount), 0);

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="w-full max-w-md glass-effect">
          <CardHeader className="text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <Users className="w-8 h-8 text-primary-foreground" />
            </div>
            <CardTitle>Espace Influenceur</CardTitle>
            <CardDescription>
              Connectez-vous pour accéder à votre tableau de bord
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button className="w-full" asChild>
              <Link to="/login?redirect=/influenceur/dashboard">Se connecter</Link>
            </Button>
            <Button variant="outline" className="w-full" asChild>
              <Link to="/signup?redirect=/influenceur/dashboard">Créer un compte</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  // Not registered as influencer yet
  if (!influencer) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-12 max-w-2xl">
          <Button variant="ghost" className="mb-8" asChild>
            <Link to="/">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Retour
            </Link>
          </Button>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Card className="glass-effect">
              <CardHeader className="text-center">
                <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                  <Sparkles className="w-10 h-10 text-primary-foreground" />
                </div>
                <CardTitle className="text-2xl">Devenir Influenceur Agentia</CardTitle>
                <CardDescription className="text-base">
                  Gagnez 20% de commission sur chaque vente générée par votre lien unique
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="text-center p-4 rounded-lg bg-secondary/50">
                    <DollarSign className="w-8 h-8 mx-auto mb-2 text-primary" />
                    <p className="font-bold text-lg">20%</p>
                    <p className="text-sm text-muted-foreground">Commission</p>
                  </div>
                  <div className="text-center p-4 rounded-lg bg-secondary/50">
                    <Clock className="w-8 h-8 mx-auto mb-2 text-primary" />
                    <p className="font-bold text-lg">1 mois</p>
                    <p className="text-sm text-muted-foreground">Durée du lien</p>
                  </div>
                  <div className="text-center p-4 rounded-lg bg-secondary/50">
                    <TrendingUp className="w-8 h-8 mx-auto mb-2 text-primary" />
                    <p className="font-bold text-lg">-50%</p>
                    <p className="text-sm text-muted-foreground">Pour vos abonnés</p>
                  </div>
                </div>

                <Separator />

                <div className="space-y-4">
                  <div>
                    <Label htmlFor="name">Votre nom (pour le code promo)</Label>
                    <Input
                      id="name"
                      placeholder="Ex: Jean Dupont"
                      value={registerName}
                      onChange={(e) => setRegisterName(e.target.value)}
                      className="mt-2"
                    />
                  </div>
                  <Button 
                    className="w-full bg-gradient-to-r from-primary to-accent"
                    onClick={handleRegister}
                    disabled={registerAsInfluencer.isPending}
                  >
                    {registerAsInfluencer.isPending ? 'Inscription...' : 'Devenir Influenceur'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 glass-effect border-b border-border">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-primary-foreground" />
            </div>
            <span className="font-orbitron font-bold text-xl gradient-text-cyan-purple">
              Agentia
            </span>
          </Link>
          <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30">
            <Users className="w-3 h-3 mr-1" />
            Espace Influenceur
          </Badge>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {/* Welcome */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground">
            Bonjour {influencer.beneficiary_name || profile?.full_name} 👋
          </h1>
          <p className="text-muted-foreground">
            Voici un aperçu de vos performances
          </p>
        </div>

        {/* Alerts */}
        {influencer.contract_status === 'pending' && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6"
          >
            <Card className="border-orange-500/30 bg-orange-500/10">
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 text-orange-500" />
                  <div>
                    <p className="font-medium text-foreground">Contrat en attente</p>
                    <p className="text-sm text-muted-foreground">
                      Signez votre contrat pour activer votre lien d'affiliation
                    </p>
                  </div>
                </div>
                <Dialog open={showContractDialog} onOpenChange={setShowContractDialog}>
                  <DialogTrigger asChild>
                    <Button>
                      <FileText className="w-4 h-4 mr-2" />
                      Voir le contrat
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle>Contrat d'Affiliation Agentia</DialogTitle>
                      <DialogDescription>
                        Veuillez lire attentivement les conditions
                      </DialogDescription>
                    </DialogHeader>
                    <div className="prose prose-sm dark:prose-invert">
                      <h3>CONTRAT D'AFFILIATION</h3>
                      <p><strong>Entre :</strong></p>
                      <ul>
                        <li>Agentia, ci-après dénommé "l'Annonceur"</li>
                        <li>{influencer.beneficiary_name || 'L\'Influenceur'}, ci-après dénommé "l'Affilié"</li>
                      </ul>
                      
                      <h4>Article 1 - Objet</h4>
                      <p>
                        Le présent contrat a pour objet de définir les conditions de partenariat 
                        entre l'Annonceur et l'Affilié dans le cadre du programme d'affiliation Agentia.
                      </p>
                      
                      <h4>Article 2 - Commission</h4>
                      <p>
                        L'Affilié percevra une commission de <strong>{influencer.commission_rate}%</strong> sur 
                        chaque vente générée via son lien d'affiliation unique.
                      </p>
                      
                      <h4>Article 3 - Durée du lien</h4>
                      <p>
                        Le lien d'affiliation est valide pour une durée de <strong>1 mois</strong> à compter 
                        de sa génération. L'Affilié peut renouveler son lien depuis son tableau de bord.
                      </p>
                      
                      <h4>Article 4 - Conditions de paiement</h4>
                      <ul>
                        <li>Paiement mensuel des commissions validées</li>
                        <li>Seuil minimum de paiement : 50€</li>
                        <li>Paiement par virement bancaire uniquement</li>
                      </ul>
                      
                      <h4>Article 5 - Code promo</h4>
                      <p>
                        Votre code promo unique : <strong>{influencer.promo_code}</strong><br/>
                        Ce code offre -50% sur la première année d'abonnement à vos abonnés.
                      </p>
                      
                      <p className="text-sm text-muted-foreground mt-6">
                        Date du contrat : {format(new Date(), 'dd MMMM yyyy', { locale: fr })}
                      </p>
                    </div>
                    <DialogFooter className="flex-col sm:flex-row gap-2">
                      <Button variant="outline" onClick={() => setShowContractDialog(false)}>
                        Annuler
                      </Button>
                      <Button variant="secondary" onClick={handleDownloadContract}>
                        <Download className="w-4 h-4 mr-2" />
                        Télécharger PDF
                      </Button>
                      <Button onClick={handleSignContract} disabled={signContract.isPending}>
                        <Check className="w-4 h-4 mr-2" />
                        Signer le contrat
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {isExpired && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6"
          >
            <Card className="border-destructive/30 bg-destructive/10">
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 text-destructive" />
                  <div>
                    <p className="font-medium text-foreground">Lien expiré</p>
                    <p className="text-sm text-muted-foreground">
                      Votre lien d'affiliation a expiré. Renouvelez-le pour continuer à gagner des commissions.
                    </p>
                  </div>
                </div>
                <Button onClick={() => regenerateLink.mutate()} disabled={regenerateLink.isPending}>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Renouveler
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-4 mb-8">
          <Card className="glass-effect">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Revenus totaux</p>
                  <p className="text-2xl font-bold text-foreground">
                    {Number(influencer.total_revenue).toFixed(2)}€
                  </p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-green-500/20 flex items-center justify-center">
                  <DollarSign className="w-6 h-6 text-green-500" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="glass-effect">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Ventes</p>
                  <p className="text-2xl font-bold text-foreground">
                    {influencer.total_sales}
                  </p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-blue-500/20 flex items-center justify-center">
                  <TrendingUp className="w-6 h-6 text-blue-500" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="glass-effect">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">En attente</p>
                  <p className="text-2xl font-bold text-foreground">
                    {totalPending.toFixed(2)}€
                  </p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-orange-500/20 flex items-center justify-center">
                  <Clock className="w-6 h-6 text-orange-500" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="glass-effect">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Commission</p>
                  <p className="text-2xl font-bold text-foreground">
                    {influencer.commission_rate}%
                  </p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center">
                  <Sparkles className="w-6 h-6 text-purple-500" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Affiliation Link */}
        <Card className="glass-effect mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="w-5 h-5" />
              Votre lien d'affiliation
            </CardTitle>
            <CardDescription>
              Partagez ce lien pour gagner des commissions
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                value={influencer.affiliation_link}
                readOnly
                className="font-mono text-sm"
              />
              <Button onClick={copyLink} variant="outline">
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            <div className="flex items-center justify-between text-sm flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline">Code: {influencer.promo_code}</Badge>
                <Badge variant="secondary">-50% pour vos abonnés</Badge>
                {influencer.contract_status === 'signed' && (
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={handleDownloadContract}
                    className="h-6 text-xs"
                  >
                    <Download className="w-3 h-3 mr-1" />
                    Télécharger contrat
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="w-4 h-4" />
                {isExpired ? (
                  <span className="text-destructive">Expiré</span>
                ) : (
                  <span>Expire {formatDistanceToNow(new Date(influencer.expires_at), { addSuffix: true, locale: fr })}</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Bank Details & Commissions */}
        <div className="grid gap-6 md:grid-cols-3">
          {/* Bank Details */}
          <Card className="glass-effect">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="w-5 h-5" />
                Coordonnées bancaires
              </CardTitle>
            </CardHeader>
            <CardContent>
              {influencer.iban ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">Bénéficiaire</p>
                  <p className="font-medium">{influencer.beneficiary_name}</p>
                  <p className="text-sm text-muted-foreground mt-3">IBAN</p>
                  <p className="font-mono text-sm">{influencer.iban.replace(/(.{4})/g, '$1 ').trim()}</p>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Ajoutez vos coordonnées bancaires pour recevoir vos paiements
                </p>
              )}
              <Dialog open={showBankDialog} onOpenChange={setShowBankDialog}>
                <DialogTrigger asChild>
                  <Button variant="outline" className="w-full mt-4">
                    {influencer.iban ? 'Modifier' : 'Ajouter'}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Coordonnées bancaires</DialogTitle>
                    <DialogDescription>
                      Ces informations sont nécessaires pour recevoir vos paiements
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="beneficiary">Nom du bénéficiaire</Label>
                      <Input
                        id="beneficiary"
                        value={beneficiaryName}
                        onChange={(e) => setBeneficiaryName(e.target.value)}
                        placeholder="Jean Dupont"
                      />
                    </div>
                    <div>
                      <Label htmlFor="iban">IBAN</Label>
                      <Input
                        id="iban"
                        value={iban}
                        onChange={(e) => setIban(e.target.value.toUpperCase())}
                        placeholder="FR76 1234 5678 9012 3456 7890 123"
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setShowBankDialog(false)}>
                      Annuler
                    </Button>
                    <Button onClick={handleUpdateBank}>
                      Enregistrer
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>

          {/* Commission History */}
          <Card className="glass-effect md:col-span-2">
            <CardHeader>
              <CardTitle>Historique des commissions</CardTitle>
            </CardHeader>
            <CardContent>
              {commissions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <DollarSign className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>Aucune commission pour le moment</p>
                  <p className="text-sm">Partagez votre lien pour commencer à gagner !</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Vente</TableHead>
                      <TableHead>Commission</TableHead>
                      <TableHead>Statut</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {commissions.slice(0, 10).map((commission) => (
                      <TableRow key={commission.id}>
                        <TableCell className="text-muted-foreground">
                          {format(new Date(commission.created_at), 'dd/MM/yyyy')}
                        </TableCell>
                        <TableCell>{Number(commission.sale_amount).toFixed(2)}€</TableCell>
                        <TableCell className="font-medium text-green-500">
                          +{Number(commission.commission_amount).toFixed(2)}€
                        </TableCell>
                        <TableCell>
                          <Badge 
                            variant={
                              commission.status === 'paid' ? 'default' : 
                              commission.status === 'validated' ? 'secondary' : 
                              'outline'
                            }
                          >
                            {commission.status === 'paid' ? 'Payé' :
                             commission.status === 'validated' ? 'Validé' :
                             commission.status === 'pending' ? 'En attente' : 'Annulé'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
