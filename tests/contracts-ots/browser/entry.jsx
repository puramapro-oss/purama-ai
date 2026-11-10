import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { AuthContext } from '../../quality/account-isolation/auth';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import AdminContracts from '@/pages/AdminContracts';
import { principal } from './backend';

for (const level of ['info', 'success', 'error']) {
  const original = toast[level].bind(toast);
  toast[level] = (...args) => {
    window.__notices.push({ level, text: String(args[0]) });
    return original(...args);
  };
}
function AuthProvider({ children }) {
  const [user, setUser] = useState(principal('A'));
  window.__principal = user.id;
  window.__setUser = id => { window.__principal = id; setUser(principal(id)); };
  return <AuthContext.Provider value={{ user, loading: false, session: { user } }}>
    <output data-testid="account">{user.id}</output>{children}
  </AuthContext.Provider>;
}
function Navigation() {
  window.__navigate = useNavigate();
  return null;
}
createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/admin/contracts']}>
    <AuthProvider>
      <Navigation />
      <Routes>
        <Route path="/admin/contracts" element={<ProtectedRoute><AdminContracts /></ProtectedRoute>} />
        <Route path="/dashboard" element={<div>Dashboard fixture</div>} />
      </Routes>
      <Toaster />
    </AuthProvider>
  </MemoryRouter>
);
