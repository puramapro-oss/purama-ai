import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorFallback, PageFallback } from './components/AppFallback';
import './index.css';

const App = lazy(() => import('./App'));

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary FallbackComponent={ErrorFallback}>
    <Suspense fallback={<PageFallback />}>
      <App />
    </Suspense>
  </ErrorBoundary>,
);
