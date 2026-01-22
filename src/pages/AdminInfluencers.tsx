import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  Users, 
  DollarSign, 
  ArrowLeft,
  Search,
  CreditCard,
  TrendingUp,
  CheckCircle2,
  Clock,
  XCircle,
  Sparkles
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
  DialogFooter,
} from '@/components/ui/dialog';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { useInfluencerAdmin, Influencer, Commission } from '@/hooks/useInfluencer';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

export default function AdminInfluencers() {
  const { allInfluencers, allCommissions, isLoading, markCommissionPaid } = useInfluencerAdmin();
  const [search, setSearch] = useState('');
  const [selectedInfluencer, setSelectedInfluencer] = useState<Influencer | null>(null);
  const [showPayDialog, setShowPayDialog] = useState(false);
  const [selectedCommission, setSelectedCommission] = useState<Commission | null>(null);

  const filteredInfluencers = allInfluencers.filter(inf => 
    inf.promo_code.toLowerCase().includes(search.toLowerCase()) ||
    inf.beneficiary_name?.toLowerCase().includes(search.toLowerCase())
  );

  const totalRevenue = allInfluencers.reduce((sum, inf) => sum + Number(inf.total_revenue), 0);
  const totalSales = allInfluencers.reduce((sum, inf) => sum + inf.total_sales, 0);
  const pendingPayments = allCommissions
    .filter(c => c.status === 'validated')
    .reduce((sum, c) => sum + Number(c.commission_amount), 0);

  const getInfluencerCommissions = (influencerId: string) => {
    return allCommissions.filter(c => c.influencer_id === influencerId);
  };

  const handlePayCommission = () => {
    if (selectedCommission) {
      markCommissionPaid.mutate(selectedCommission.id);
      setShowPayDialog(false);
      setSelectedCommission(null);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />
      
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/dashboard">
              <ArrowLeft className="w-5 h-5" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Users className="w-6 h-6" />
              Gestion des Influenceurs
            </h1>
            <p className="text-muted-foreground">
              Gérez vos partenaires et leurs commissions
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4 mb-8">
          <Card className="glass-effect">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Influenceurs</p>
                  <p className="text-2xl font-bold">{allInfluencers.length}</p>
                </div>
                <Users className="w-8 h-8 text-primary opacity-50" />
              </div>
            </CardContent>
          </Card>
          <Card className="glass-effect">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Ventes totales</p>
                  <p className="text-2xl font-bold">{totalSales}</p>
                </div>
                <TrendingUp className="w-8 h-8 text-green-500 opacity-50" />
              </div>
            </CardContent>
          </Card>
          <Card className="glass-effect">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Commissions payées</p>
                  <p className="text-2xl font-bold">{totalRevenue.toFixed(0)}€</p>
                </div>
                <DollarSign className="w-8 h-8 text-blue-500 opacity-50" />
              </div>
            </CardContent>
          </Card>
          <Card className="glass-effect">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">En attente</p>
                  <p className="text-2xl font-bold">{pendingPayments.toFixed(0)}€</p>
                </div>
                <Clock className="w-8 h-8 text-orange-500 opacity-50" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Search */}
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Rechercher un influenceur..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Influencers Table */}
        <Card className="glass-effect">
          <CardHeader>
            <CardTitle>Tous les influenceurs</CardTitle>
          </CardHeader>
          <CardContent>
            {filteredInfluencers.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>Aucun influenceur inscrit</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Influenceur</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Ventes</TableHead>
                    <TableHead>Revenus</TableHead>
                    <TableHead>Contrat</TableHead>
                    <TableHead>IBAN</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredInfluencers.map((influencer) => {
                    const commissions = getInfluencerCommissions(influencer.id);
                    const pendingCommissions = commissions.filter(c => c.status === 'validated');
                    
                    return (
                      <TableRow key={influencer.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium">{influencer.beneficiary_name || 'Non défini'}</p>
                            <p className="text-xs text-muted-foreground">
                              Inscrit le {format(new Date(influencer.created_at), 'dd/MM/yyyy')}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono">
                            {influencer.promo_code}
                          </Badge>
                        </TableCell>
                        <TableCell>{influencer.total_sales}</TableCell>
                        <TableCell className="font-medium">
                          {Number(influencer.total_revenue).toFixed(2)}€
                        </TableCell>
                        <TableCell>
                          <Badge 
                            variant={influencer.contract_status === 'signed' ? 'default' : 'secondary'}
                            className={influencer.contract_status === 'signed' ? 'bg-green-500/20 text-green-400' : ''}
                          >
                            {influencer.contract_status === 'signed' ? (
                              <><CheckCircle2 className="w-3 h-3 mr-1" /> Signé</>
                            ) : influencer.contract_status === 'pending' ? (
                              <><Clock className="w-3 h-3 mr-1" /> En attente</>
                            ) : (
                              <><XCircle className="w-3 h-3 mr-1" /> Expiré</>
                            )}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {influencer.iban ? (
                            <Badge variant="outline" className="bg-green-500/10 text-green-400">
                              <CreditCard className="w-3 h-3 mr-1" />
                              Configuré
                            </Badge>
                          ) : (
                            <Badge variant="secondary">Non configuré</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setSelectedInfluencer(influencer)}
                            >
                              Détails
                            </Button>
                            {pendingCommissions.length > 0 && (
                              <Button
                                size="sm"
                                onClick={() => {
                                  setSelectedCommission(pendingCommissions[0]);
                                  setShowPayDialog(true);
                                }}
                              >
                                Payer ({pendingCommissions.length})
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Influencer Detail Dialog */}
        <Dialog open={!!selectedInfluencer} onOpenChange={() => setSelectedInfluencer(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Détails de l'influenceur</DialogTitle>
            </DialogHeader>
            {selectedInfluencer && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Nom</p>
                    <p className="font-medium">{selectedInfluencer.beneficiary_name}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Code promo</p>
                    <p className="font-mono">{selectedInfluencer.promo_code}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Commission</p>
                    <p className="font-medium">{selectedInfluencer.commission_rate}%</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Expiration du lien</p>
                    <p>{format(new Date(selectedInfluencer.expires_at), 'dd MMMM yyyy', { locale: fr })}</p>
                  </div>
                  {selectedInfluencer.iban && (
                    <>
                      <div className="col-span-2">
                        <p className="text-sm text-muted-foreground">IBAN</p>
                        <p className="font-mono">{selectedInfluencer.iban}</p>
                      </div>
                    </>
                  )}
                </div>

                <div>
                  <h4 className="font-medium mb-3">Historique des commissions</h4>
                  <div className="max-h-60 overflow-y-auto">
                    {getInfluencerCommissions(selectedInfluencer.id).length === 0 ? (
                      <p className="text-muted-foreground text-center py-4">Aucune commission</p>
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
                          {getInfluencerCommissions(selectedInfluencer.id).map(commission => (
                            <TableRow key={commission.id}>
                              <TableCell>{format(new Date(commission.created_at), 'dd/MM/yyyy')}</TableCell>
                              <TableCell>{Number(commission.sale_amount).toFixed(2)}€</TableCell>
                              <TableCell className="text-green-500">
                                +{Number(commission.commission_amount).toFixed(2)}€
                              </TableCell>
                              <TableCell>
                                <Badge variant={commission.status === 'paid' ? 'default' : 'secondary'}>
                                  {commission.status}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Pay Dialog */}
        <Dialog open={showPayDialog} onOpenChange={setShowPayDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirmer le paiement</DialogTitle>
              <DialogDescription>
                Marquer cette commission comme payée ?
              </DialogDescription>
            </DialogHeader>
            {selectedCommission && (
              <div className="p-4 bg-secondary/50 rounded-lg">
                <p className="text-lg font-bold text-green-500">
                  {Number(selectedCommission.commission_amount).toFixed(2)}€
                </p>
                <p className="text-sm text-muted-foreground">
                  Commission sur une vente de {Number(selectedCommission.sale_amount).toFixed(2)}€
                </p>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowPayDialog(false)}>
                Annuler
              </Button>
              <Button onClick={handlePayCommission} disabled={markCommissionPaid.isPending}>
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Confirmer le paiement
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
