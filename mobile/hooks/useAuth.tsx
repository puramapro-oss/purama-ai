import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  profile: Profile | null;
  signUp: (email: string, password: string, fullName?: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signInWithGoogle: () => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: string;
  plan: string;
  credits: number;
  daily_questions: number;
  referral_code: string | null;
  wallet_balance: number;
  tier: string;
  xp: number;
  level: number;
  streak: number;
  purama_points: number;
  tutorial_completed: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [{ session, revision }, setAuthState] = useState<{ session: Session | null; revision: number }>({ session: null, revision: 0 });
  const user = session?.user ?? null;
  const userId = user?.id ?? null;
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const mounted = useRef(true);
  const sessionEstablished = useRef(false);
  const sessionRevision = useRef(0);
  const profileRequest = useRef(0);
  const activeUserId = useRef<string | null>(null);

  const applySession = useCallback((nextSession: Session | null) => {
    if (!mounted.current) return;
    const nextUserId = nextSession?.user.id ?? null;
    sessionEstablished.current = true;
    sessionRevision.current += 1;
    profileRequest.current += 1;
    if (nextUserId === null || activeUserId.current !== nextUserId) setProfile(null);
    activeUserId.current = nextUserId;
    setAuthState({ session: nextSession, revision: sessionRevision.current });
    setLoading(false);
  }, []);

  const fetchProfile = useCallback(async (requestedUserId: string) => {
    if (!mounted.current || activeUserId.current !== requestedUserId) return;
    const request = ++profileRequest.current;
    const authRevision = sessionRevision.current;
    const isCurrent = () => mounted.current
      && sessionRevision.current === authRevision
      && profileRequest.current === request
      && activeUserId.current === requestedUserId;

    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", requestedUserId)
        .single();
      if (isCurrent()) {
        setProfile(!error && data?.id === requestedUserId ? data as Profile : null);
      }
    } catch {
      // A missing/failed current profile must not leave stale account data visible.
      if (isCurrent()) setProfile(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        // Supabase invokes this inside its auth lock. Only publish state here.
        if (active) applySession(nextSession);
      }
    );

    void supabase.auth.getSession().then(({ data, error }) => {
      // An auth event or explicit sign-out supersedes this startup snapshot.
      if (active && !sessionEstablished.current) {
        applySession(error ? null : data.session);
      }
    }).catch(() => {
      if (active && !sessionEstablished.current) applySession(null);
    });

    return () => {
      active = false;
      mounted.current = false;
      sessionRevision.current += 1;
      profileRequest.current += 1;
      subscription.unsubscribe();
    };
  }, [applySession]);

  useEffect(() => {
    if (!userId) return;
    void fetchProfile(userId);
    return () => { profileRequest.current += 1; };
  }, [userId, revision, fetchProfile]);

  const signUp = async (email: string, password: string, fullName?: string) => {
    try {
      const redirectUrl = Platform.OS === "web"
        ? `${typeof window !== "undefined" ? window.location.origin : ""}/auth/callback`
        : Linking.createURL("auth/callback");

      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectUrl,
          data: { full_name: fullName },
        },
      });
      return { error: error ? new Error(error.message) : null };
    } catch (err) {
      return { error: err as Error };
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error ? new Error(error.message) : null };
    } catch (err) {
      return { error: err as Error };
    }
  };

  const signInWithGoogle = async () => {
    try {
      const redirectUrl = Linking.createURL("auth/callback");
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: redirectUrl,
          skipBrowserRedirect: true,
        },
      });

      if (error) return { error: new Error(error.message) };
      if (data?.url) {
        const result = await WebBrowser.openAuthSessionAsync(data.url, redirectUrl);
        if (result.type === "success") {
          const url = result.url;
          const params = new URL(url);
          const accessToken = params.searchParams.get("access_token") || params.hash?.match(/access_token=([^&]*)/)?.[1];
          const refreshToken = params.searchParams.get("refresh_token") || params.hash?.match(/refresh_token=([^&]*)/)?.[1];

          if (accessToken && refreshToken) {
            await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          }
        }
      }
      return { error: null };
    } catch (err) {
      return { error: err as Error };
    }
  };

  const signOut = async () => {
    // Invalidate reads immediately; a late completion must not erase a new sign-in.
    applySession(null);
    await supabase.auth.signOut();
  };

  const refreshProfile = useCallback(async () => {
    const currentUserId = activeUserId.current;
    if (currentUserId) await fetchProfile(currentUserId);
  }, [fetchProfile]);

  return (
    <AuthContext.Provider value={{ user, session, loading, profile, signUp, signIn, signInWithGoogle, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
