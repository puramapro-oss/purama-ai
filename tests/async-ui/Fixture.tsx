import { useEffect, useState, type ReactNode } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../src/components/auth/AuthProvider';
import { useAuth as useRealAuth } from '../../src/hooks/useAuth';
import { AgentChatTab } from '../../src/components/voice/AgentChatTab';
import CreatorAgentDetail from '../../src/pages/CreatorAgentDetail';
import { Auth, initialUser } from './auth-state';
import { harness } from './transport';
import type { AgentChatType } from '../../src/lib/agent-chat';

function AuthState() {
  const { user, loading } = useRealAuth();
  return <><output data-testid="auth-user">{user?.id ?? 'signed-out'}</output><output data-testid="auth-loading">{String(loading)}</output></>;
}
function TestIdentity({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<typeof initialUser | null>(initialUser);
  useEffect(() => { harness.setIdentity = id => setUser(id ? { ...initialUser, id } : null); }, []);
  return <Auth.Provider value={{ user }}>{children}</Auth.Provider>;
}
function AgentFixture() {
  const [type, setType] = useState<AgentChatType>('email');
  useEffect(() => { harness.setAgentType = type => setType(type as AgentChatType); }, []);
  return <AgentChatTab agentType={type} agentName={type} agentEmoji="🤖" agentColor="#8B5CF6" />;
}
export function Fixture() {
  const kind = new URLSearchParams(location.search).get('kind') || 'agent';
  if (kind === 'auth') return <AuthProvider><AuthState /></AuthProvider>;
  return <TestIdentity>{kind === 'creator' ? <>
    <Link to="/creator/10000000-0000-4000-8000-000000000001">Agent A</Link>
    <Link to="/creator/10000000-0000-4000-8000-000000000002">Agent B</Link>
    <Routes><Route path="/creator/:id" element={<CreatorAgentDetail />} /></Routes>
  </> : <AgentFixture />}</TestIdentity>;
}
