import type { PlaywrightTestConfig } from '@playwright/test';

// Linux engine coverage and emulated viewports only. These names deliberately
// do not claim physical devices, Safari, Chrome, Edge, or manufacturer coverage.
export const matrixProjects: NonNullable<PlaywrightTestConfig['projects']> = [
  {
    name: 'chromium-small-touch-320x568',
    use: {
      browserName: 'chromium',
      userAgent: undefined,
      viewport: { width: 320, height: 568 },
      screen: { width: 320, height: 568 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
      launchOptions: {
        ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
        args: [
          '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--disable-gpu',
          '--no-proxy-server',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        ],
      },
    },
  },
  {
    name: 'firefox-desktop-1280x800',
    use: {
      browserName: 'firefox',
      userAgent: undefined,
      viewport: { width: 1280, height: 800 },
      screen: { width: 1280, height: 800 },
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
      launchOptions: {},
    },
  },
  {
    name: 'webkit-desktop-1280x800',
    use: {
      browserName: 'webkit',
      userAgent: undefined,
      viewport: { width: 1280, height: 800 },
      screen: { width: 1280, height: 800 },
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
      launchOptions: {},
    },
  },
  {
    name: 'webkit-mobile-touch-390x844',
    use: {
      browserName: 'webkit',
      userAgent: undefined,
      viewport: { width: 390, height: 844 },
      screen: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
      launchOptions: {},
    },
  },
  {
    name: 'webkit-tablet-touch-768x1024',
    use: {
      browserName: 'webkit',
      userAgent: undefined,
      viewport: { width: 768, height: 1024 },
      screen: { width: 768, height: 1024 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
      launchOptions: {},
    },
  },
];
