import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';

export default function OAuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [message, setMessage] = useState('Connexion en cours...');

  useEffect(() => {
    const handleCallback = async () => {
      const code = searchParams.get('code');
      const state = searchParams.get('state');
      const error = searchParams.get('error');

      if (error) {
        setStatus('error');
        setMessage('Autorisation refusée');
        toast.error('Connexion annulée');
        setTimeout(() => navigate('/mes-connexions'), 2000);
        return;
      }

      if (!code || !state) {
        setStatus('error');
        setMessage('Paramètres manquants');
        setTimeout(() => navigate('/mes-connexions'), 2000);
        return;
      }

      // Verify state matches
      const storedState = sessionStorage.getItem('oauth_state');
      if (state !== storedState) {
        setStatus('error');
        setMessage('État invalide - possible attaque CSRF');
        setTimeout(() => navigate('/mes-connexions'), 2000);
        return;
      }

      try {
        // Exchange code for tokens via edge function
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/oauth-google?action=callback&code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
          {
            headers: {
              'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
            },
          }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Erreur de connexion');
        }

        sessionStorage.removeItem('oauth_state');
        setStatus('success');
        setMessage('Compte connecté avec succès !');
        toast.success('Compte connecté avec succès');
        
        setTimeout(() => {
          navigate(data.returnUrl || '/mes-connexions');
        }, 1500);

      } catch (err) {
        console.error('OAuth callback error:', err);
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'Erreur de connexion');
        toast.error('Erreur lors de la connexion');
        setTimeout(() => navigate('/mes-connexions'), 2000);
      }
    };

    handleCallback();
  }, [searchParams, navigate]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="glass-effect rounded-2xl p-12 text-center max-w-md">
        {status === 'processing' && (
          <>
            <Loader2 className="w-16 h-16 mx-auto mb-4 text-primary animate-spin" />
            <h1 className="text-xl font-semibold text-foreground mb-2">Connexion en cours</h1>
            <p className="text-muted-foreground">{message}</p>
          </>
        )}
        
        {status === 'success' && (
          <>
            <CheckCircle2 className="w-16 h-16 mx-auto mb-4 text-green-500" />
            <h1 className="text-xl font-semibold text-foreground mb-2">Succès !</h1>
            <p className="text-muted-foreground">{message}</p>
          </>
        )}
        
        {status === 'error' && (
          <>
            <XCircle className="w-16 h-16 mx-auto mb-4 text-destructive" />
            <h1 className="text-xl font-semibold text-foreground mb-2">Erreur</h1>
            <p className="text-muted-foreground">{message}</p>
          </>
        )}
      </div>
    </div>
  );
}
