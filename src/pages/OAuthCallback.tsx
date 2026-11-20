import { useEffect, useLayoutEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useRequestScope, useScopedState } from '@/hooks/useRequestScope';
import { createRequestScope } from '@/lib/request-scope';
import { clearOAuthContext, invokeOAuth, OAuthClientError, readOAuthContext } from '@/lib/oauth-google';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';

export default function OAuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const userId = user?.id ?? null;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const denied = searchParams.get('error');
  const scopeKey = JSON.stringify([userId, loading, code, state, denied]);
  const capture = useRequestScope(scopeKey);
  const [requests] = useState(createRequestScope);
  const [status, setStatus] = useScopedState<'processing' | 'success' | 'error'>(scopeKey, 'processing');
  const [message, setMessage] = useScopedState(scopeKey, 'Connexion en cours...');
  const [returnPath, setReturnPath] = useScopedState(scopeKey, '/mes-connexions');
  useLayoutEffect(() => () => requests.invalidate(), [scopeKey, requests]);

  useEffect(() => {
    if (loading) return;
    const current = capture();
    const request = requests.begin('callback');
    if (!request) return;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;
    const admitted = () => current() && request.current();
    const handleCallback = async () => {
      try {
        setStatus('processing');
        setMessage('Connexion en cours...');
        const context = readOAuthContext();
        if (!context || !state || state !== context.state) {
          setStatus('error'); setMessage('Cette connexion est invalide ou ancienne. Recommencez depuis vos connexions.'); return;
        }
        const destination = context.purpose === 'email_agent_gmail' ? '/dashboard/email-agent' : '/mes-connexions';
        setReturnPath(destination);
        if (!userId || context.userId !== userId) {
          setStatus('error'); setMessage('Connectez-vous au compte qui a démarré cette connexion, puis recommencez.'); return;
        }
        if (denied) {
          clearOAuthContext(state);
          setStatus('error'); setMessage('Autorisation refusée'); return;
        }
        if (!code) {
          setStatus('error'); setMessage('Paramètres manquants. Recommencez la connexion.'); return;
        }
        const endpoint = context.purpose === 'email_agent_gmail' ? 'email-agent-gmail-oauth' : 'oauth-google';
        const result = await invokeOAuth(endpoint, { action: 'callback', code, state }, userId, request.signal);
        if (!admitted()) return;
        if (readOAuthContext()?.state !== state) {
          setStatus('error'); setMessage('Une autre connexion a été démarrée. Reprenez depuis vos connexions.'); return;
        }
        if (result.success !== true || result.provider !== context.provider || result.returnUrl !== destination) {
          throw new OAuthClientError();
        }
        clearOAuthContext(state);
        if (!admitted()) return;
        setStatus('success'); setMessage('Compte connecté avec succès !');
        toast.success('Compte connecté avec succès');
        redirectTimer = setTimeout(() => {
          if (current()) navigate(destination, { replace: true });
        }, 1500);
      } catch (error) {
        if (!admitted()) return;
        setStatus('error');
        setMessage(error instanceof OAuthClientError && error.status === 409
          ? 'Cette connexion a expiré ou a déjà été utilisée. Recommencez depuis vos connexions.'
          : error instanceof OAuthClientError && error.status === 401
            ? 'Votre session a changé. Reconnectez-vous puis recommencez la connexion.'
            : error instanceof OAuthClientError && error.status === 403
              ? 'Les autorisations nécessaires n’ont pas toutes été accordées. Recommencez la connexion pour les vérifier.'
              : 'La connexion n’a pas pu être confirmée. Recommencez depuis vos connexions.');
      } finally { request.finish(); }
    };
    void handleCallback();
    return () => {
      if (redirectTimer !== undefined) clearTimeout(redirectTimer);
      requests.cancel('callback');
    };
  }, [loading, userId, code, state, denied, capture, navigate, requests, setStatus, setMessage, setReturnPath]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="glass-effect rounded-2xl p-12 text-center max-w-md" role="status" aria-live="polite">
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
        {status !== 'processing' && (
          <Link className="inline-block mt-6 text-primary underline" to={returnPath} replace>
            Retour à mes connexions
          </Link>
        )}
      </div>
    </div>
  );
}
