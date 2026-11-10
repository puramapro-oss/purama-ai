import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route,useNavigate,useLocation} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {AuthContext} from './auth';
import {ProtectedRoute} from '@/components/auth/ProtectedRoute';
import PartnerAgentEmails from '@/pages/PartnerAgentEmails';
import ComptaAgentSettings from '@/pages/ComptaAgentSettings';
import {ExecutionCounter} from '@/components/dashboard/ExecutionCounter';
import {useVoice} from '@/hooks/useVoice';
import {AgentChatTab} from '@/components/voice/AgentChatTab';
import LegalAgentChat from '@/pages/LegalAgentChat';
import CreatorAgentDetail from '@/pages/CreatorAgentDetail';
import {useCustomAgentKartaState,useUpdateCustomAgentKartaState,useCustomAgentKartaRuns,useCustomAgentPendingActions} from 'real-karta-hooks';
const query=new URLSearchParams(location.search);
const type=query.get('component');
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
window.__queryClient=queryClient;
function AuthProvider({children}){
 const [user,setUser]=useState(query.get('anonymous')==='1'?null:{id:'A',email:'a@example.test'});
 window.__setUser=setUser;
 return <AuthContext.Provider value={{user,loading:false,session:{user}}}><output data-testid="account">{user?.id||'anonymous'}</output>{children}</AuthContext.Provider>;
}
function Bridge(){window.__navigate=useNavigate();const {pathname,search}=useLocation();return <output data-testid="path">{pathname+search}</output>;}
function VoiceProbe(){const voice=useVoice();window.__voice=voice;return <output data-testid="voice">{JSON.stringify({settings:voice.settings,loading:voice.loadingSettings,recording:voice.isRecording,transcribing:voice.isTranscribing})}</output>;}
function KartaProbe(){
 const state=useCustomAgentKartaState('shared-agent');
 const runs=useCustomAgentKartaRuns('shared-agent',20);
 const actions=useCustomAgentPendingActions('shared-agent');
 window.__updateKarta=useUpdateCustomAgentKartaState('shared-agent');
 return <output data-testid="karta">{JSON.stringify({state:state.data??null,runs:runs.data??[],actions:actions.data??[]})}</output>;
}
function PersistentProbe(){const [value,setValue]=useState(0);useEffect(()=>{window.__mounts=(window.__mounts||0)+1;},[]);return <button onClick={()=>setValue(v=>v+1)}>Counter {value}</button>;}
function Content(){
 const [visible,setVisible]=useState(true);window.__hide=()=>setVisible(false);if(!visible)return null;
 const child=type==='emails'?<PartnerAgentEmails/>:type==='compta'?<ComptaAgentSettings/>:type==='usage'?<ExecutionCounter/>:type==='agentChat'?<AgentChatTab agentType="compta" agentName="Fixture" agentEmoji="" agentColor="cyan"/>:type==='legalChat'?<LegalAgentChat/>:type==='creator'?<CreatorAgentDetail/>:type==='karta'?<KartaProbe/>:type==='probe'?<PersistentProbe/>:<VoiceProbe/>;
 return query.get('unprotected')==='1'?child:<ProtectedRoute>{child}</ProtectedRoute>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[type==='creator'?'/agents/alpha':'/review']}><AuthProvider><Bridge/><Routes><Route path="/agents/:id" element={<Content/>}/><Route path="*" element={<Content/>}/></Routes></AuthProvider></MemoryRouter></QueryClientProvider>);
