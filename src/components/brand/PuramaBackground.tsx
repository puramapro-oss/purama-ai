// ─── <PuramaBackground /> — fond animé cohérent avec le mood de l'app ───
//
// Usage :
//   <PuramaBackground variant="hero" overlayOpacity={0.2}>
//     <Hero />
//   </PuramaBackground>
//
// Respecte :
//  · prefers-reduced-motion (speed = 0)
//  · visibilitychange (speed = 0 si onglet caché — économie batterie)
//  · WebGL fallback (rend un gradient statique si pas de WebGL)

import { useEffect, useMemo, useState } from 'react';
import { MeshGradient } from '@paper-design/shaders-react';
import { getPalette } from '@/lib/brand/palette-generator';
import { APP_SEED } from '@/lib/brand/app-config';
import type { ShaderVariant } from '@/lib/brand/purama-adn';

interface Props {
  seed?: string;
  variant?: ShaderVariant;
  className?: string;
  overlayOpacity?: number;
  fallbackImage?: string;
  children?: React.ReactNode;
}

export function PuramaBackground({
  seed = APP_SEED,
  variant = 'hero',
  className = '',
  overlayOpacity = 0,
  fallbackImage,
  children,
}: Props) {
  const [webgl, setWebgl] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [visible, setVisible] = useState(true);
  const palette = useMemo(() => getPalette(seed, variant), [seed, variant]);

  useEffect(() => {
    try {
      const c = document.createElement('canvas');
      const ctx = c.getContext('webgl') || c.getContext('experimental-webgl');
      setWebgl(!!ctx);
    } catch {
      setWebgl(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handler = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // Fallback sans WebGL : gradient + image optionnelle
  if (!webgl) {
    const gradient = `linear-gradient(135deg, ${palette.colors[0]} 0%, ${palette.colors[1]} 50%, ${palette.colors[3]} 100%)`;
    return (
      <div
        className={`relative w-full h-full ${className}`}
        style={{
          background: fallbackImage ? `url(${fallbackImage}) center/cover, ${gradient}` : gradient,
        }}
      >
        {overlayOpacity > 0 && (
          <div className="absolute inset-0 bg-black pointer-events-none" style={{ opacity: overlayOpacity }} />
        )}
        <div className="relative z-10 w-full h-full">{children}</div>
      </div>
    );
  }

  const speed = reduced || !visible ? 0 : palette.speed;

  return (
    <div
      className={`relative w-full h-full overflow-hidden ${className}`}
      style={{ background: palette.colorBack }}
    >
      <div className="absolute inset-0 pointer-events-none" aria-hidden>
        <MeshGradient
          colors={palette.colors}
          distortion={palette.distortion}
          swirl={palette.swirl}
          speed={speed}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
      {overlayOpacity > 0 && (
        <div className="absolute inset-0 bg-black pointer-events-none" style={{ opacity: overlayOpacity }} />
      )}
      <div className="relative z-10 w-full h-full">{children}</div>
    </div>
  );
}
