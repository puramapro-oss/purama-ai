import './transport';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChatbotWidget } from '../../src/components/ChatbotWidget';
import { LiveDemoSection } from '../../src/components/LiveDemoSection';
import Workshop from '../../src/pages/Workshop';
import { TestAuth } from './auth';
import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><MemoryRouter><TestAuth>
  <ChatbotWidget /><Routes>
    <Route path="/dashboard/atelier" element={<Workshop />} />
    <Route path="*" element={<LiveDemoSection />} />
  </Routes>
</TestAuth></MemoryRouter></React.StrictMode>);
