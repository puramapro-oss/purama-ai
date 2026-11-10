import { useEffect, useState, type ReactNode } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { DEFAULT_AUTH_CONTINUATION, safeAuthContinuation } from '@/lib/auth-continuation';
import { AuthContext } from '../../hooks/useAuth';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let receivedAuthEvent = false;
    const applySession = (next: Session | null) => {
      setSession(next);
      setUser(next?.user ?? null);
      setLoading(false);
    };
    // Subscribe first; a newer auth event takes precedence over the initial read.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, next) => {
        if (!active) return;
        receivedAuthEvent = true;
        applySession(next);
      }
    );
    void supabase.auth.getSession()
      .then(({ data: { session: initial } }) => {
        if (active && !receivedAuthEvent) applySession(initial);
      })
      .catch(() => {
        if (active && !receivedAuthEvent) applySession(null);
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const signUp = async (email: string, password: string, fullName?: string, next?: string) => {
    const destination = safeAuthContinuation(next) ?? DEFAULT_AUTH_CONTINUATION;
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: next === undefined ? window.location.origin : `${window.location.origin}${destination}`,
        data: { full_name: fullName },
      },
    });
    return { error, hasSession: Boolean(data.session) };
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  };

  const signInWithGoogle = async (next?: string) => {
    const destination = safeAuthContinuation(next) ?? DEFAULT_AUTH_CONTINUATION;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        // The provider performs authentication; only a validated internal
        // continuation is supplied here, subject to its redirect allowlist.
        redirectTo: `${window.location.origin}${destination}`,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
    return { error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    localStorage.removeItem('purama-theme');
    localStorage.removeItem('purama_awakening');
    localStorage.removeItem('purama_gratitude');
    sessionStorage.clear();
    window.location.href = '/login';
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signUp, signIn, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
