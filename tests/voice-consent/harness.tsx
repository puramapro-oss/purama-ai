import './transport';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { TestAuth } from './auth';
import { harness } from './transport';
import { useVoice } from '../../src/hooks/useVoice';
import { VoiceMode } from '../../src/components/voice/VoiceMode';
import { AgentChatTab } from '../../src/components/voice/AgentChatTab';
import { newAgentSessionId, sendAgentChatMessage } from '../../src/lib/agent-chat';
import { newSessionId as newLegalSession, sendChatMessage } from '../../src/lib/legal';
import { newSessionId as newCreatorSession, chatWithAgent } from '../../src/lib/creator-agent';
import { ChatMessageSchema } from '../../supabase/functions/_shared/validation';
import { synthesizeSpeech as actualSynthesizeSpeech, transcribeAudio as actualTranscribeAudio } from '../../src/lib/voice';
import '../../src/index.css';

Object.assign(harness, { newAgentSessionId, newLegalSession, newCreatorSession, sendAgentChatMessage, sendChatMessage, chatWithAgent,
  actualSynthesizeSpeech, actualTranscribeAudio,
  validateSession: (session_id: string) => ChatMessageSchema.safeParse({ session_id, message: 'Bonjour', agent_type: 'email' }).success,
});

function VoiceFixture() {
  const voice = useVoice();
  const [open, setOpen] = useState(false);
  useEffect(() => { harness.voice = voice; harness.setModeOpen = setOpen; }, [voice]);
  return <>
    <output data-testid="recording">{String(voice.isRecording)}</output>
    <output data-testid="transcribing">{String(voice.isTranscribing)}</output>
    <output data-testid="speaking">{String(voice.isSpeaking)}</output>
    <VoiceMode open={open} onClose={() => setOpen(false)} voice={voice} agentName="Fixture IA"
      onSend={async (text, signal) => {
        const result = await harness.defer('backend', { text, signal }) as { data: { reply: string } };
        return result.data.reply;
      }} />
  </>;
}

function Fixture() {
  const [mounted, setMounted] = useState(true);
  const [agentView, setAgentView] = useState(false);
  useEffect(() => { harness.setMounted = setMounted; harness.setAgentView = setAgentView; }, []);
  if (!mounted) return <div>Fixture démontée</div>;
  return agentView
    ? <AgentChatTab agentType="email" agentName="Email IA" agentEmoji="🤖" agentColor="#8B5CF6" />
    : <VoiceFixture />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><MemoryRouter><TestAuth><Fixture /></TestAuth></MemoryRouter></React.StrictMode>,
);
