import { useEffect } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { useReferralTracking } from '@/hooks/useInfluencer';

/**
 * Lien d'affiliation court /go/[slug] (brief PRICING & OFFRE IRRÉSISTIBLE). Réutilise le mécanisme
 * de tracking existant (localStorage `referral_code`, cf useReferralTracking dans useInfluencer.ts —
 * validé au moment du checkout, pas ici) au lieu de le dupliquer ; ajoute uniquement le cookie 7
 * jours explicitement demandé par le brief pour ce format de lien court.
 */
export default function GoRedirect() {
  const { slug } = useParams<{ slug: string }>();
  const { checkAndStoreReferral } = useReferralTracking();

  useEffect(() => {
    if (!slug) return;
    const code = checkAndStoreReferral(new URLSearchParams({ ref: slug }).toString());
    if (!code) return;
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString();
    try {
      document.cookie = `purama_ref=${encodeURIComponent(code)}; expires=${expires}; path=/; SameSite=Lax`;
    } catch {
      // Cookie refusal must not block the short-link destination.
    }
  }, [slug, checkAndStoreReferral]);

  return <Navigate to={`/?${new URLSearchParams({ ref: slug?.toUpperCase() ?? '' })}`} replace />;
}
