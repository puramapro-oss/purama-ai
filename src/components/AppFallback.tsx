import { Loader2 } from 'lucide-react';
import type { FallbackProps } from 'react-error-boundary';

export function PageFallback() {
  return (
    <div role="status" className="flex h-screen w-full items-center justify-center bg-background">
      <Loader2 aria-hidden="true" className="h-8 w-8 animate-spin text-primary" />
      <span className="sr-only">Chargement…</span>
    </div>
  );
}

export function ErrorFallback({ error }: FallbackProps) {
  const message = error instanceof Error ? error.message : 'Une erreur inattendue est survenue.';
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="text-center max-w-md">
        <h1 className="text-2xl font-bold mb-4 text-foreground">Une erreur est survenue</h1>
        <p className="text-muted-foreground mb-4">{message}</p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition"
          >
            Recharger la page
          </button>
          <a href="/offline.html" className="text-primary underline">Ouvrir l’espace local</a>
        </div>
      </div>
    </div>
  );
}
