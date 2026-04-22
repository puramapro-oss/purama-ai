---
name: design-code
description: "CSS fond d'écran animé,glass card,bouton,sidebar desktop,bottom tab mobile,Hero3D R3F,landing cinématique,variantes CSS domaine(trading/wellness/legal/gamified),variables couleurs par app."
---
# DESIGN CODE
**FOND D'ÉCRAN MAGNIFIQUE(CHAQUE PAGE)**:
```css
body { background: #0A0A0F; }
.app-bg {
  position: fixed; inset: 0; z-index: -1; overflow: hidden;
  background: #0A0A0F;
}
.app-bg::before {
  content: ''; position: absolute;
  width: 600px; height: 600px; border-radius: 50%;
  top: -200px; right: -100px;
  background: radial-gradient(circle, var(--color-accent) 0%, transparent 70%);
  opacity: 0.08; filter: blur(80px);
  animation: float 20s ease-in-out infinite;
}
.app-bg::after {
  content: ''; position: absolute;
  width: 400px; height: 400px; border-radius: 50%;
  bottom: -100px; left: -50px;
  background: radial-gradient(circle, var(--color-secondary) 0%, transparent 70%);
  opacity: 0.06; filter: blur(60px);
  animation: float 25s ease-in-out infinite reverse;
}
@keyframes float {
  0%,100% { transform: translate(0,0) scale(1); }
  33% { transform: translate(30px,-20px) scale(1.05); }
  66% { transform: translate(-20px,15px) scale(0.95); }
}
.app-grid {
  position: fixed; inset: 0; z-index: -1;
  background-image: linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
                    linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
  background-size: 60px 60px;
}
.app-noise {
  position: fixed; inset: 0; z-index: -1;
  opacity: 0.03;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E");
}
```
**GLASS CARD(copier partout)**:
```tsx
<div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6
  shadow-[0_8px_32px_rgba(0,0,0,0.3)] hover:bg-white/[0.07]
  transition-all duration-300 ease-out">
  {children}
</div>
```
**BOUTON PRINCIPAL(copier partout)**:
```tsx
<button className="w-full h-12 rounded-xl font-semibold text-white
  bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-secondary)]
  hover:opacity-90 active:scale-[0.98] transition-all duration-200
  shadow-[0_4px_20px_rgba(var(--accent-rgb),0.3)]">
  {label}
</button>
```
**SIDEBAR DESKTOP(copier)**:
```tsx
<aside className="hidden lg:flex flex-col w-[280px] h-screen bg-white/[0.03]
  border-r border-white/10 p-4 justify-between">
  <div>
    <Logo className="w-10 h-10 mb-8" />
    {links.map(l => (
      <Link key={l.href} href={l.href} className={`flex items-center gap-3 px-4 py-3
        rounded-xl text-sm font-medium transition-all duration-200
        ${active === l.href ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80 hover:bg-white/5'}`}>
        <l.icon className="w-5 h-5" />{l.label}
      </Link>
    ))}
  </div>
  <button onClick={signOut} className="flex items-center gap-3 px-4 py-3 text-white/40
    hover:text-red-400 transition-colors text-sm">
    <LogOut className="w-5 h-5" />Déconnexion
  </button>
</aside>
```
**BOTTOM TAB BAR MOBILE(copier)**:
```tsx
<nav className="lg:hidden fixed bottom-0 inset-x-0 h-16 bg-black/80 backdrop-blur-xl
  border-t border-white/10 flex items-center justify-around px-2 z-50
  safe-area-bottom">
  {tabs.map(t => (
    <Link key={t.href} href={t.href} className={`flex flex-col items-center gap-1
      ${active === t.href ? 'text-[var(--color-accent)]' : 'text-white/40'}`}>
      <t.icon className="w-6 h-6" />
      <span className="text-[10px] font-medium">{t.label}</span>
    </Link>
  ))}
</nav>
```
**VARIABLES CSS PAR APP(dans globals.css)**:chaque app définit `--color-accent` et `--color-secondary` et `--accent-rgb` dans :root. Ex MIDAS:`--color-accent:#F59E0B;--color-secondary:#7C3AED;--accent-rgb:245,158,11`. Ex KAÏA:`--color-accent:#06B6D4;--color-secondary:#10B981;--accent-rgb:6,182,212`.
**Principes**:Intentionnalité(chaque pixel=but)|Thumb-centric(zone pouce,touch min 44px)|Micro-interactions(tap→scale-95+opacity-90 200ms,toggle→spring bounce,success→confettis+haptic)|Espacement généreux(p-6 gap-4 minimum,jamais entassé)|Hiérarchie typo(titre=text-2xl font-bold,sous-titre=text-lg font-medium text-white/70,body=text-sm text-white/50)|Empty states=illustration SVG+texte empathique+CTA(JAMAIS "Rien ici")|Loading=Skeleton shape exacte du contenu(JAMAIS spinner générique)|Erreur=card rouge/orange+message FR+bouton retry.
**Typo/app**:MIDAS #F59E0B Orbitron|SUTRA #8B5CF6 Space Grotesk|JurisPurama #6D28D9 Cormorant Garamond|KAÏA #06B6D4 Fraunces|VIDA #10B981 Syne|Lingora #3B82F6 Space Grotesk|KASH #F59E0B Manrope|EntreprisePilot #6366F1 Cabinet Grotesk|Purama AI #8B5CF6 Syne|Origin #D946EF Clash Display|AKASHA #00d4ff Space Grotesk|AETHER #E879F9 Outfit|EXODUS #22C55E Sora|PRANA #F472B6 Fraunces|Compta #0EA5E9 Manrope|LUMIOS #14B8A6 Cabinet Grotesk|MANA #A855F7 DM Sans
**Hero3D+Landing(PAGE PUBLIQUE non-connecté seulement)**:R3F+MeshDistort+Stars. tsParticles. Lottie. PWA. Landing cinématique:hero(3D+particules accent)→stats(compteurs animés depuis DB)→features(scroll reveal stagger)→démo(mockup interactif)→how(timeline)→pricing(glass cards+popular pulse)→FAQ(accordion spring)→CTA(magnetic button)→footer(citations sagesse). **MAIS l'interface connectée=APP**(sidebar+bottom tabs+plein écran).
**VARIANTES DESIGN PAR DOMAINE(override les defaults selon le BRIEF)**:
```css
.wellness { --color-accent: #06B6D4; --color-secondary: #10B981; --accent-rgb: 6,182,212; }
.wellness .app-bg::before { opacity: 0.05; animation-duration: 30s; } 
.wellness .app-bg::after { opacity: 0.04; animation-duration: 35s; }
.wellness .glass-card { @apply rounded-3xl p-8 border-white/[0.06]; } 
.wellness .btn { @apply rounded-2xl h-14; transition-duration: 500ms; } 
.wellness h1 { @apply text-3xl font-light tracking-wide; } 
.wellness .spacing { @apply p-8 gap-6; } 
.wellness body { background: linear-gradient(180deg, #0A0F0D 0%, #0A0A0F 100%); }
.trading { --color-accent: #F59E0B; --color-secondary: #7C3AED; --accent-rgb: 245,158,11; }
.trading .glass-card { @apply rounded-xl p-4; } 
