import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  Bell, 
  CheckCheck, 
  ExternalLink, 
  Trash2, 
  ArrowLeft,
  Filter,
  CheckCircle2,
  HelpCircle,
  BarChart3,
  AlertTriangle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useNotifications, NotificationType } from '@/hooks/useNotifications';
import { useAgents } from '@/hooks/useAgents';
import { formatDistanceToNow, format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';

const typeConfig: Record<NotificationType, { icon: typeof Bell; label: string; color: string }> = {
  task_completed: { 
    icon: CheckCircle2, 
    label: 'Tâche terminée', 
    color: 'bg-green-500/20 text-green-400 border-green-500/30' 
  },
  question: { 
    icon: HelpCircle, 
    label: 'Question', 
    color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' 
  },
  daily_report: { 
    icon: BarChart3, 
    label: 'Rapport quotidien', 
    color: 'bg-purple-500/20 text-purple-400 border-purple-500/30' 
  },
  alert: { 
    icon: AlertTriangle, 
    label: 'Alerte', 
    color: 'bg-orange-500/20 text-orange-400 border-orange-500/30' 
  },
};

export default function Notifications() {
  const { notifications, unreadCount, markAsRead, markAllAsRead, deleteNotification } = useNotifications();
  const { data: agents = [] } = useAgents();
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  // Get unique agent slugs from notifications
  const agentSlugs = [...new Set(notifications.map(n => n.agent_slug).filter(Boolean))];

  // Filter notifications
  const filteredNotifications = notifications.filter(notification => {
    if (typeFilter !== 'all' && notification.type !== typeFilter) return false;
    if (agentFilter !== 'all' && notification.agent_slug !== agentFilter) return false;
    return true;
  });

  // Group notifications by date
  const groupedNotifications = filteredNotifications.reduce((groups, notification) => {
    const date = format(new Date(notification.created_at), 'yyyy-MM-dd');
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(notification);
    return groups;
  }, {} as Record<string, typeof notifications>);

  const dateGroups = Object.entries(groupedNotifications).sort((a, b) => 
    new Date(b[0]).getTime() - new Date(a[0]).getTime()
  );

  const formatDateHeader = (dateStr: string) => {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (format(date, 'yyyy-MM-dd') === format(today, 'yyyy-MM-dd')) {
      return "Aujourd'hui";
    }
    if (format(date, 'yyyy-MM-dd') === format(yesterday, 'yyyy-MM-dd')) {
      return 'Hier';
    }
    return format(date, 'EEEE d MMMM yyyy', { locale: fr });
  };

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />
      
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" asChild>
              <Link to="/dashboard">
                <ArrowLeft className="w-5 h-5" />
              </Link>
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
                <Bell className="w-6 h-6" />
                Mes notifications
              </h1>
              <p className="text-muted-foreground">
                {unreadCount > 0 
                  ? `${unreadCount} notification${unreadCount > 1 ? 's' : ''} non lue${unreadCount > 1 ? 's' : ''}`
                  : 'Toutes les notifications sont lues'
                }
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <Button
                variant="outline"
                onClick={() => markAllAsRead.mutate()}
                disabled={markAllAsRead.isPending}
              >
                <CheckCheck className="w-4 h-4 mr-2" />
                Tout marquer comme lu
              </Button>
            )}
          </div>
        </div>

        {/* Filters */}
        <Card className="p-4 mb-6 glass-effect">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Filtres:</span>
            </div>
            
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les types</SelectItem>
                {Object.entries(typeConfig).map(([type, config]) => (
                  <SelectItem key={type} value={type}>
                    <span className="flex items-center gap-2">
                      <config.icon className="w-4 h-4" />
                      {config.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les agents</SelectItem>
                {agentSlugs.map(slug => {
                  const agent = agents.find(a => a.slug === slug);
                  return (
                    <SelectItem key={slug} value={slug!}>
                      {agent?.name || slug}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>

            {(typeFilter !== 'all' || agentFilter !== 'all') && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setTypeFilter('all');
                  setAgentFilter('all');
                }}
              >
                Réinitialiser
              </Button>
            )}
          </div>
        </Card>

        {/* Notifications list */}
        {filteredNotifications.length === 0 ? (
          <Card className="p-12 text-center glass-effect">
            <Bell className="w-16 h-16 mx-auto mb-4 text-muted-foreground opacity-50" />
            <h3 className="text-lg font-medium text-foreground mb-2">
              Aucune notification
            </h3>
            <p className="text-muted-foreground">
              {typeFilter !== 'all' || agentFilter !== 'all'
                ? 'Aucune notification ne correspond à vos filtres'
                : 'Vous n\'avez pas encore reçu de notifications'}
            </p>
          </Card>
        ) : (
          <div className="space-y-6">
            {dateGroups.map(([date, notifs]) => (
              <div key={date}>
                <h2 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">
                  {formatDateHeader(date)}
                </h2>
                <div className="space-y-3">
                  {notifs.map((notification, index) => {
                    const TypeIcon = typeConfig[notification.type].icon;
                    return (
                      <motion.div
                        key={notification.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                      >
                        <Card 
                          className={`p-4 glass-effect hover:bg-secondary/30 transition-colors cursor-pointer ${
                            !notification.read ? 'border-l-4 border-l-primary' : ''
                          }`}
                          onClick={() => {
                            if (!notification.read) {
                              markAsRead.mutate(notification.id);
                            }
                          }}
                        >
                          <div className="flex gap-4">
                            {/* Icon */}
                            <div className={`flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center border ${typeConfig[notification.type].color}`}>
                              <TypeIcon className="w-5 h-5" />
                            </div>
                            
                            {/* Content */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <p className={`font-medium ${!notification.read ? 'text-foreground' : 'text-muted-foreground'}`}>
                                    {notification.title}
                                  </p>
                                  <div className="flex items-center gap-2 mt-1">
                                    <Badge variant="outline" className={`text-xs ${typeConfig[notification.type].color}`}>
                                      {typeConfig[notification.type].label}
                                    </Badge>
                                    {notification.agent_slug && (
                                      <Badge variant="secondary" className="text-xs">
                                        {agents.find(a => a.slug === notification.agent_slug)?.name || notification.agent_slug}
                                      </Badge>
                                    )}
                                  </div>
                                </div>
                                {!notification.read && (
                                  <span className="flex-shrink-0 w-2 h-2 rounded-full bg-primary" />
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground mt-2">
                                {notification.message}
                              </p>
                              <p className="text-xs text-muted-foreground mt-2">
                                {formatDistanceToNow(new Date(notification.created_at), { 
                                  addSuffix: true, 
                                  locale: fr 
                                })}
                              </p>
                            </div>

                            {/* Actions */}
                            <div className="flex-shrink-0 flex gap-1">
                              {notification.action_url && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  asChild
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <Link to={notification.action_url}>
                                    <ExternalLink className="w-4 h-4" />
                                  </Link>
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-destructive hover:text-destructive"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteNotification.mutate(notification.id);
                                }}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        </Card>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
