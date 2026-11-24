import { test, expect } from '../../../tests/public/fixtures';

type HeroMotionSample = {
  elapsed: number;
  frames: number;
  sinceLastFrame: number;
  visibility: string;
  rect: { x: number; y: number; width: number; height: number } | null;
  ancestors: {
    tag: string;
    transform: string;
    opacity: string;
    display: string;
    visibility: string;
    animations: { playState: string; currentTime: string; duration: string; endTime: string }[];
  }[];
};

type HeroMotionData = {
  environment: { userAgent: string; devicePixelRatio: number; hardwareConcurrency: number };
  frames: number;
  intervals: number;
  firstFrameDelay: number | null;
  maxFrameGap: number;
  maxIntervalGap: number;
  backdropSurfaces: {
    tag: string;
    cssClass: string;
    backdropFilter: string;
    webkitBackdropFilter: string;
    rect: { x: number; y: number; width: number; height: number };
    intersectsViewport: boolean;
  }[];
  samples: HeroMotionSample[];
};

declare global {
  interface Window {
    __iaoHeroMotionProbe?: {
      data: HeroMotionData;
      stop: () => HeroMotionData;
    };
  }
}

// Observational probe only: the original navigation test remains unchanged.
// Geometry/computed-style reads can affect rendering timing. A passing probe
// cannot by itself invalidate the separately retained baseline failure.
test('hero CTA keeps native frame callbacks and reaches signup with an ordinary click', async ({ page, browser, browserName }, testInfo) => {
  await page.addInitScript(() => {
    const started = performance.now();
    let lastFrame = started;
    let lastInterval = started;
    let animationFrame = 0;
    let stopped = false;
    const data: HeroMotionData = {
      environment: {
        userAgent: navigator.userAgent,
        devicePixelRatio,
        hardwareConcurrency: navigator.hardwareConcurrency,
      },
      frames: 0,
      intervals: 0,
      firstFrameDelay: null,
      maxFrameGap: 0,
      maxIntervalGap: 0,
      backdropSurfaces: [],
      samples: [],
    };
    const frame = (time: number) => {
      if (stopped) return;
      if (data.firstFrameDelay === null) data.firstFrameDelay = time - started;
      data.frames += 1;
      data.maxFrameGap = Math.max(data.maxFrameGap, time - lastFrame);
      lastFrame = time;
      animationFrame = requestAnimationFrame(frame);
    };
    animationFrame = requestAnimationFrame(frame);
    const interval = window.setInterval(() => {
      const now = performance.now();
      data.intervals += 1;
      data.maxIntervalGap = Math.max(data.maxIntervalGap, now - lastInterval);
      lastInterval = now;
      if (data.samples.length >= 260) return;
      // Inspect known filter-bearing class families once per second, keeping
      // the last nonempty set if SPA navigation removes the landing page.
      if (data.intervals % 10 === 0) {
        const surfaces: HeroMotionData['backdropSurfaces'] = [];
        const candidates = document.querySelectorAll('[class*="backdrop-"], [class*="glass"], [style*="backdrop-filter"]');
        for (const element of Array.from(candidates)) {
          const style = getComputedStyle(element);
          const backdropFilter = style.getPropertyValue('backdrop-filter');
          const webkitBackdropFilter = style.getPropertyValue('-webkit-backdrop-filter');
          if ((!backdropFilter || backdropFilter === 'none') && (!webkitBackdropFilter || webkitBackdropFilter === 'none')) continue;
          const rect = element.getBoundingClientRect();
          surfaces.push({
            tag: element.tagName,
            cssClass: element.getAttribute('class') ?? '',
            backdropFilter,
            webkitBackdropFilter,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            intersectsViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
          });
        }
        if (surfaces.length > 0) data.backdropSurfaces = surfaces;
      }
      const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('#hero a[href="/signup"]'))
        .find(element => element.textContent?.trim() === 'Commencer gratuitement');
      const rect = link?.getBoundingClientRect();
      const ancestors: HeroMotionSample['ancestors'] = [];
      for (let element: Element | null = link ?? null; element && ancestors.length < 4; element = element.parentElement) {
        const style = getComputedStyle(element);
        ancestors.push({
          tag: element.tagName,
          transform: style.transform,
          opacity: style.opacity,
          display: style.display,
          visibility: style.visibility,
          animations: element.getAnimations().map(animation => {
            const timing = animation.effect?.getComputedTiming();
            return {
              playState: animation.playState,
              currentTime: String(animation.currentTime),
              duration: String(timing?.duration),
              endTime: String(timing?.endTime),
            };
          }),
        });
      }
      data.samples.push({
        elapsed: now - started,
        frames: data.frames,
        sinceLastFrame: now - lastFrame,
        visibility: document.visibilityState,
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        ancestors,
      });
    }, 100);
    window.__iaoHeroMotionProbe = {
      data,
      stop: () => {
        stopped = true;
        cancelAnimationFrame(animationFrame);
        clearInterval(interval);
        return data;
      },
    };
  });

  let observation: HeroMotionData | { error: string } | null = null;
  try {
    await page.goto('/', { waitUntil: 'networkidle' });
    const signup = page.locator('#hero').getByRole('link', { name: 'Commencer gratuitement', exact: true });
    await expect(signup).toHaveAttribute('href', '/signup');
    // A shorter action budget leaves time for failure evidence inside the same
    // 30-second test limit. It does not change the canonical navigation test.
    await signup.click({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('heading', { name: 'Créer un compte', exact: true })).toBeVisible();
  } finally {
    try {
      observation = await page.evaluate(() => window.__iaoHeroMotionProbe?.stop() ?? null);
    } catch (error) {
      observation = { error: error instanceof Error ? error.message : String(error) };
    }
    await testInfo.attach('hero-motion-observation.json', {
      body: Buffer.from(JSON.stringify({
        scope: 'Read-only timing observation on Linux WebKit with real public navigation',
        bias: 'Sampling geometry and computed styles every 100ms can change rendering timing; canonical navigation assertions run separately without this observer.',
        browserName,
        browserVersion: browser.version(),
        project: testInfo.project.name,
        finalUrl: page.url(),
        observation,
      }, null, 2)),
      contentType: 'application/json',
    });
  }
});
