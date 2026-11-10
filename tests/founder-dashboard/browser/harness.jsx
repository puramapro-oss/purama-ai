import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import AdminDashboard from '../../../src/pages/AdminDashboard';
import { TestAuthProvider } from './auth-mock';
import '../../../src/index.css';
createRoot(document.getElementById('root')).render(<TestAuthProvider><BrowserRouter><AdminDashboard /></BrowserRouter></TestAuthProvider>);
