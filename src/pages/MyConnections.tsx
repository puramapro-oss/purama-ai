import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  ArrowLeft, 
  Link2, 
  CheckCircle2, 
  XCircle, 
  ExternalLink,
  Loader2,
  RefreshCw,
  Unlink
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { useUserConnections, SERVICE_CONFIG, ServiceProvider } from '@/hooks/useUserConnections';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';

export default function MyConnections() {
  const { 
    connections, 
    isLoading, 
    isConnected, 
    getConnection,
    disconnect, 
    initiateOAuth 
  } = useUserConnections();

  const services: ServiceProvider[] = ['google_sheets', 'gmail', 'google_calendar', 'google_drive'];

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />
      
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/dashboard">
              <ArrowLeft className="w-5 h-5" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Link2 className="w-6 h-6" />
              Mes connexions
            </h1>
            <p className="text-muted-foreground">
              Connectez vos comptes pour permettre aux agents d'accéder à vos services
            </p>
          </div>
        </div>

        {/* Info Card */}
        <Card className="mb-8 glass-effect border-primary/20 bg-primary/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                <Link2 className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-sm text-foreground font-medium">Pourquoi connecter mes comptes ?</p>
                <p className="text-sm text-muted-foreground mt-1">
                  En connectant vos comptes Google, vous permettez à nos agents IA d'accéder à vos données 
                  pour automatiser vos tâches. Vos tokens sont stockés de manière sécurisée et vous pouvez 
                  révoquer l'accès à tout moment.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Services Grid */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="grid gap-4">
            {services.map((provider, index) => {
              const config = SERVICE_CONFIG[provider];
              const connected = isConnected(provider);
              const connection = getConnection(provider);

              return (
                <motion.div
                  key={provider}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.1 }}
                >
                  <Card className={`glass-effect transition-all ${connected ? 'border-green-500/30' : 'hover:border-primary/30'}`}>
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          {/* Icon */}
                          <div className={`w-14 h-14 rounded-xl flex items-center justify-center text-2xl ${
                            connected 
                              ? 'bg-green-500/20 border border-green-500/30' 
                              : 'bg-secondary'
                          }`}>
                            {config.icon}
                          </div>
                          
                          {/* Info */}
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold text-foreground">{config.name}</h3>
                              {connected && (
                                <Badge variant="outline" className="bg-green-500/10 text-green-400 border-green-500/30">
                                  <CheckCircle2 className="w-3 h-3 mr-1" />
                                  Connecté
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground mt-1">
                              {config.description}
                            </p>
                            {connected && connection?.token_expires_at && (
                              <p className="text-xs text-muted-foreground mt-2">
                                Token expire {formatDistanceToNow(new Date(connection.token_expires_at), { 
                                  addSuffix: true, 
                                  locale: fr 
                                })}
                              </p>
                            )}
                            {config.requiredByAgents.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-2">
                                <span className="text-xs text-muted-foreground">Utilisé par :</span>
                                {config.requiredByAgents.slice(0, 3).map(agent => (
                                  <Badge key={agent} variant="secondary" className="text-xs">
                                    {agent}
                                  </Badge>
                                ))}
                                {config.requiredByAgents.length > 3 && (
                                  <Badge variant="secondary" className="text-xs">
                                    +{config.requiredByAgents.length - 3}
                                  </Badge>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2">
                          {connected ? (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => initiateOAuth(provider)}
                                className="text-muted-foreground"
                              >
                                <RefreshCw className="w-4 h-4 mr-2" />
                                Reconnecter
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => disconnect.mutate(provider)}
                                disabled={disconnect.isPending}
                                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                              >
                                <Unlink className="w-4 h-4 mr-2" />
                                Déconnecter
                              </Button>
                            </>
                          ) : (
                            <Button
                              onClick={() => initiateOAuth(provider)}
                              className="bg-gradient-to-r from-primary to-accent"
                            >
                              <ExternalLink className="w-4 h-4 mr-2" />
                              Connecter
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        )}

        {/* Security Note */}
        <Card className="mt-8 glass-effect">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              🔒 Sécurité de vos données
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>• Vos tokens d'accès sont chiffrés et stockés de manière sécurisée</p>
            <p>• Nous n'avons jamais accès à vos mots de passe Google</p>
            <p>• Vous pouvez révoquer l'accès à tout moment depuis cette page ou depuis Google</p>
            <p>• Les agents n'accèdent qu'aux données nécessaires à leur fonctionnement</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
