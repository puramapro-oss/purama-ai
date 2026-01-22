import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  ArrowLeft, 
  Bell, 
  Mail, 
  CheckCircle2, 
  HelpCircle, 
  BarChart3, 
  AlertTriangle,
  Settings
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useNotificationPreferences } from '@/hooks/useNotifications';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { Skeleton } from '@/components/ui/skeleton';

export default function NotificationSettings() {
  const { preferences, isLoading, updatePreferences } = useNotificationPreferences();

  const handleToggle = (key: keyof typeof preferences, value: boolean) => {
    if (!preferences) return;
    updatePreferences.mutate({ [key]: value });
  };

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />
      
      <div className="container mx-auto px-4 py-8 max-w-2xl">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/dashboard">
              <ArrowLeft className="w-5 h-5" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Settings className="w-6 h-6" />
              Préférences de notification
            </h1>
            <p className="text-muted-foreground">
              Personnalisez les notifications que vous recevez
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-6">
            <Skeleton className="h-[200px] w-full" />
            <Skeleton className="h-[300px] w-full" />
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            {/* Email notifications */}
            <Card className="glass-effect">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mail className="w-5 h-5" />
                  Notifications par email
                </CardTitle>
                <CardDescription>
                  Recevez un email pour chaque notification importante
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="email-enabled" className="text-base">
                      Activer les emails
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Nous vous enverrons un email pour les notifications importantes
                    </p>
                  </div>
                  <Switch
                    id="email-enabled"
                    checked={preferences?.email_enabled ?? true}
                    onCheckedChange={(checked) => handleToggle('email_enabled', checked)}
                    disabled={updatePreferences.isPending}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Notification types */}
            <Card className="glass-effect">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bell className="w-5 h-5" />
                  Types de notifications
                </CardTitle>
                <CardDescription>
                  Choisissez les types de notifications que vous souhaitez recevoir
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Task completed */}
                <div className="flex items-center justify-between">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                      <CheckCircle2 className="w-5 h-5 text-green-400" />
                    </div>
                    <div className="space-y-0.5">
                      <Label htmlFor="task-completed" className="text-base">
                        Tâches terminées
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Quand un agent a fini son travail
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="task-completed"
                    checked={preferences?.task_completed_enabled ?? true}
                    onCheckedChange={(checked) => handleToggle('task_completed_enabled', checked)}
                    disabled={updatePreferences.isPending}
                  />
                </div>

                <Separator />

                {/* Questions */}
                <div className="flex items-center justify-between">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center">
                      <HelpCircle className="w-5 h-5 text-blue-400" />
                    </div>
                    <div className="space-y-0.5">
                      <Label htmlFor="question" className="text-base">
                        Questions des agents
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Quand un agent a besoin d'une réponse de votre part
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="question"
                    checked={preferences?.question_enabled ?? true}
                    onCheckedChange={(checked) => handleToggle('question_enabled', checked)}
                    disabled={updatePreferences.isPending}
                  />
                </div>

                <Separator />

                {/* Daily reports */}
                <div className="flex items-center justify-between">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-purple-500/20 flex items-center justify-center">
                      <BarChart3 className="w-5 h-5 text-purple-400" />
                    </div>
                    <div className="space-y-0.5">
                      <Label htmlFor="daily-report" className="text-base">
                        Rapports quotidiens
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Résumé de ce que vos agents ont fait chaque jour
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="daily-report"
                    checked={preferences?.daily_report_enabled ?? true}
                    onCheckedChange={(checked) => handleToggle('daily_report_enabled', checked)}
                    disabled={updatePreferences.isPending}
                  />
                </div>

                <Separator />

                {/* Alerts */}
                <div className="flex items-center justify-between">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-orange-500/20 flex items-center justify-center">
                      <AlertTriangle className="w-5 h-5 text-orange-400" />
                    </div>
                    <div className="space-y-0.5">
                      <Label htmlFor="alert" className="text-base">
                        Alertes
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Problèmes détectés ou actions requises
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="alert"
                    checked={preferences?.alert_enabled ?? true}
                    onCheckedChange={(checked) => handleToggle('alert_enabled', checked)}
                    disabled={updatePreferences.isPending}
                  />
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </div>
    </div>
  );
}
