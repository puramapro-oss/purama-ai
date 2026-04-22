// ─── Purama · INSEE Sirene API (V4.1 — vérification SIRET) ───────────────
//
// Utilise la clé universelle INSEE (active depuis 06/04/2026) pour toutes
// les apps Purama qui manipulent un SIRET (MOKSHA, JurisPurama,
// EntreprisePilot, Purama Compta, et purama-ai pour les pro users).
//
// Le token est utilisé côté Edge Function uniquement (header secret).
// Ce fichier expose les types + l'appel client qui passe par notre
// endpoint proxy `/functions/v1/insee-verify-siret` pour ne jamais
// exposer la clé au navigateur.
// ───────────────────────────────────────────────────────────────────────

import { supabase } from '@/integrations/supabase/client';

export interface InseeEtablissement {
  siret: string;
  siren: string;
  denominationUniteLegale: string | null;
  categorieJuridique: string | null;
  activitePrincipaleEtablissement: string | null;
  dateCreationEtablissement: string | null;
  etatAdministratifEtablissement: 'A' | 'F'; // A=Actif, F=Fermé
  adresse: {
    numero: string | null;
    voie: string | null;
    codePostal: string | null;
    commune: string | null;
  };
}

export interface VerifySiretResult {
  valid: boolean;
  active: boolean;
  etablissement?: InseeEtablissement;
  error?: string;
}

/**
 * Appelle l'Edge Function proxy qui interroge l'API INSEE Sirene.
 * Le SIRET doit faire 14 chiffres.
 */
export async function verifySiret(siret: string): Promise<VerifySiretResult> {
  const clean = siret.replace(/\s+/g, '');
  if (!/^\d{14}$/.test(clean)) {
    return { valid: false, active: false, error: 'SIRET invalide (14 chiffres requis).' };
  }
  try {
    const { data, error } = await supabase.functions.invoke('insee-verify-siret', {
      body: { siret: clean },
    });
    if (error) return { valid: false, active: false, error: error.message };
    return data as VerifySiretResult;
  } catch (e) {
    return { valid: false, active: false, error: (e as Error).message };
  }
}

/**
 * Formatte un SIRET 14 chiffres en "XXX XXX XXX XXXXX"
 */
export function formatSiret(siret: string): string {
  const clean = siret.replace(/\s+/g, '');
  if (clean.length !== 14) return siret;
  return `${clean.slice(0, 3)} ${clean.slice(3, 6)} ${clean.slice(6, 9)} ${clean.slice(9)}`;
}
