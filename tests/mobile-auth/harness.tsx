import { StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../../mobile/hooks/useAuth";
import { control } from "./mocks/supabase";

type Snapshot = { user: string | null; session: string | null; profile: string | null; label: string | null; loading: boolean };
const renders: Snapshot[] = [];
const failures: string[] = [];
let current: ReturnType<typeof useAuth> | undefined;
let savedRefresh: (() => Promise<void>) | undefined;
const root = createRoot(document.getElementById("root")!);

const actions = {
  ...control,
  renders: () => renders,
  failures: () => failures,
  refresh() { void current!.refreshProfile().catch((error: Error) => failures.push(error.message)); },
  saveRefresh() { savedRefresh = current!.refreshProfile; },
  savedRefresh() { void savedRefresh!().catch((error: Error) => failures.push(error.message)); },
  signOut() { void current!.signOut().catch((error: Error) => failures.push(error.message)); },
  unmount() { root.unmount(); },
};

declare global {
  interface Window { mobileAuth: typeof actions; }
}
window.mobileAuth = actions;

export function Probe() {
  current = useAuth();
  const snapshot: Snapshot = { user: current.user?.id ?? null, session: current.session?.user.id ?? null, profile: current.profile?.id ?? null, label: current.profile?.full_name ?? null, loading: current.loading };
  useLayoutEffect(() => { renders.push(snapshot); });
  return <main>
    <output data-testid="user">{snapshot.user ?? "none"}</output>
    <output data-testid="session">{snapshot.session ?? "none"}</output>
    <output data-testid="profile">{snapshot.profile ?? "none"}</output>
    <output data-testid="label">{snapshot.label ?? "none"}</output>
    <output data-testid="loading">{String(snapshot.loading)}</output>
  </main>;
}

const content = <AuthProvider><Probe /></AuthProvider>;
root.render(new URLSearchParams(location.search).has("strict") ? <StrictMode>{content}</StrictMode> : content);
