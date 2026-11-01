import './transport';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatbotWidget } from '../../src/components/ChatbotWidget';
import { LiveDemoSection } from '../../src/components/LiveDemoSection';
import { TestAuth } from './auth';
import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><MemoryRouter><TestAuth>
  <ChatbotWidget /><LiveDemoSection />
</TestAuth></MemoryRouter></React.StrictMode>);
