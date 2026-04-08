import { Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Loader2 } from 'lucide-react';

/**
 * Forge has been merged into the real Creator Agent module.
 * Authenticated users are sent to the new-agent wizard, guests are sent to signup.
 */
export default function Forge() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (user) {
    return <Navigate to="/dashboard/creator-agent/new" replace />;
  }
  return <Navigate to="/signup?next=/dashboard/creator-agent/new" replace />;
}
