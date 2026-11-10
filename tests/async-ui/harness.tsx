import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Fixture } from './Fixture';
import './transport';
import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/creator/10000000-0000-4000-8000-000000000001']}><Fixture /><Toaster /></MemoryRouter>);
