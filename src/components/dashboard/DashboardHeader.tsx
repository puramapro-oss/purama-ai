import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile, useSubscription } from '@/hooks/useProfile';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { LogOut, User, Settings, Crown, Sparkles, Bell } from 'lucide-react';
import { NotificationCenter } from '@/components/notifications/NotificationCenter';

export function DashboardHeader() {
  const { user, signOut } = useAuth();
  const { data: profile } = useProfile();
  const { data: subscription } = useSubscription();

  const initials = profile?.full_name
    ? profile.full_name.split(' ').map((n) => n[0]).join('').toUpperCase()
    : user?.email?.[0].toUpperCase() || '?';

  const isPremium = subscription?.plan_type !== 'free';

  return (
    <header className="sticky top-0 z-50 glass-effect border-b border-border">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary-foreground" />
          </div>
          <span className="font-orbitron font-bold text-xl gradient-text-cyan-purple">
            Agentia
          </span>
        </Link>

        {/* User menu */}
        <div className="flex items-center gap-4">
          {/* Plan badge */}
          <Badge 
            variant={isPremium ? 'default' : 'secondary'}
            className={isPremium ? 'bg-gradient-to-r from-amber-500 to-orange-500 border-0' : ''}
          >
            {isPremium ? (
              <>
                <Crown className="w-3 h-3 mr-1" />
                {subscription?.plan_type}
              </>
            ) : (
              'Plan Gratuit'
            )}
          </Badge>

          {/* Notification Center */}
          <NotificationCenter />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="relative h-10 w-10 rounded-full">
                <Avatar className="h-10 w-10 border-2 border-primary/50">
                  <AvatarImage src={profile?.avatar_url || undefined} />
                  <AvatarFallback className="bg-secondary text-foreground">
                    {initials}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56 glass-effect" align="end">
              <DropdownMenuLabel>
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium">{profile?.full_name || 'Utilisateur'}</p>
                  <p className="text-xs text-muted-foreground">{user?.email}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link to="/notifications">
                  <Bell className="mr-2 h-4 w-4" />
                  Mes notifications
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <User className="mr-2 h-4 w-4" />
                Mon profil
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/notification-settings">
                  <Settings className="mr-2 h-4 w-4" />
                  Paramètres notifications
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={signOut} className="text-destructive">
                <LogOut className="mr-2 h-4 w-4" />
                Déconnexion
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
