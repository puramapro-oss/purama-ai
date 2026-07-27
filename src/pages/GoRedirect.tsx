import { useEffect } from 'react';
import { useParams, Navigate } from 'react-router-dom';

/**
 * Lien d'affiliation court /go/[slug] (brief PRICING & OFFRE IRRÉSISTIBLE). Réutilise le mécanisme
 * de tracking existant (localStorage `referral_code`, cf useReferralTracking dans useInfluencer.ts —
 * validé au moment du checkout, pas ici) au lieu de le dupliquer ; ajoute uniquement le cookie 7
 * jours explicitement demandé par le brief pour ce format de lien court.
 */
export default function GoRedirect() {
  const { slug } = useParams<{ slug: string }>();

  useEffect(() => {
    if (!slug) return;
    const code = slug.toUpperCase();
    localStorage.setItem('referral_code', code);
    localStorage.setItem('referral_timestamp', Date.now().toString());

    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `purama_ref=${code}; expires=${expires}; path=/; SameSite=Lax`;
  }, [slug]);

  return <Navigate to={`/?ref=${slug?.toUpperCase() ?? ''}`} replace />;
}
