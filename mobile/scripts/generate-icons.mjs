import sharp from "sharp";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, "..", "assets");

const BG = "#0A0A0F";
const ACCENT = "#8B5CF6";

// SVG for the "P" logo with gradient accent
function createLogoSVG(size, padding = 0) {
  const viewSize = size - padding * 2;
  const fontSize = Math.round(viewSize * 0.5);
  return Buffer.from(`
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:${ACCENT};stop-opacity:1" />
          <stop offset="100%" style="stop-color:#06B6D4;stop-opacity:1" />
        </linearGradient>
        <linearGradient id="textGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#FFFFFF;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#E0E0FF;stop-opacity:0.95" />
        </linearGradient>
      </defs>
      <rect x="${padding}" y="${padding}" width="${viewSize}" height="${viewSize}" rx="${Math.round(viewSize * 0.22)}" fill="${BG}"/>
      <rect x="${padding + viewSize * 0.15}" y="${padding + viewSize * 0.15}" width="${viewSize * 0.7}" height="${viewSize * 0.7}" rx="${Math.round(viewSize * 0.15)}" fill="url(#grad)" opacity="0.15"/>
      <text x="${size / 2}" y="${size / 2 + fontSize * 0.35}" font-family="Arial Black, sans-serif" font-size="${fontSize}" font-weight="900" text-anchor="middle" fill="url(#textGrad)">P</text>
    </svg>
  `);
}

function createSplashSVG(w, h) {
  return Buffer.from(`
    <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${w}" height="${h}" fill="${BG}"/>
      <circle cx="${w/2}" cy="${h*0.35}" r="60" fill="${ACCENT}" opacity="0.08"/>
      <circle cx="${w*0.3}" cy="${h*0.6}" r="120" fill="#06B6D4" opacity="0.04"/>
      <text x="${w/2}" y="${h*0.42}" font-family="Arial Black, sans-serif" font-size="80" font-weight="900" text-anchor="middle" fill="white">P</text>
      <text x="${w/2}" y="${h*0.50}" font-family="Arial, sans-serif" font-size="28" font-weight="600" text-anchor="middle" fill="${ACCENT}">Purama AI</text>
      <text x="${w/2}" y="${h*0.55}" font-family="Arial, sans-serif" font-size="16" text-anchor="middle" fill="rgba(255,255,255,0.4)">Tes agents IA au quotidien</text>
    </svg>
  `);
}

async function generate() {
  console.log("Generating icons...");

  // icon.png 1024x1024
  await sharp(createLogoSVG(1024))
    .resize(1024, 1024)
    .png()
    .toFile(join(assetsDir, "icon.png"));
  console.log("  icon.png");

  // adaptive-icon.png 1024x1024 with padding
  await sharp(createLogoSVG(1024, 100))
    .resize(1024, 1024)
    .png()
    .toFile(join(assetsDir, "adaptive-icon.png"));
  console.log("  adaptive-icon.png");

  // favicon.png 48x48
  await sharp(createLogoSVG(48))
    .resize(48, 48)
    .png()
    .toFile(join(assetsDir, "favicon.png"));
  console.log("  favicon.png");

  // splash.png 1284x2778
  await sharp(createSplashSVG(1284, 2778))
    .resize(1284, 2778)
    .png()
    .toFile(join(assetsDir, "splash.png"));
  console.log("  splash.png");

  // notification-icon.png 96x96 (Android)
  await sharp(createLogoSVG(96))
    .resize(96, 96)
    .png()
    .toFile(join(assetsDir, "notification-icon.png"));
  console.log("  notification-icon.png");

  // feature-graphic.png 1024x500 (Play Store)
  const featureSVG = Buffer.from(`
    <svg width="1024" height="500" xmlns="http://www.w3.org/2000/svg">
      <rect width="1024" height="500" fill="${BG}"/>
      <circle cx="512" cy="200" r="80" fill="${ACCENT}" opacity="0.1"/>
      <text x="512" y="230" font-family="Arial Black, sans-serif" font-size="100" font-weight="900" text-anchor="middle" fill="white">P</text>
      <text x="512" y="320" font-family="Arial, sans-serif" font-size="36" font-weight="700" text-anchor="middle" fill="${ACCENT}">Purama AI</text>
      <text x="512" y="370" font-family="Arial, sans-serif" font-size="20" text-anchor="middle" fill="rgba(255,255,255,0.5)">6 agents IA pour gerer ton business</text>
    </svg>
  `);
  await sharp(featureSVG).resize(1024, 500).png().toFile(join(assetsDir, "feature-graphic.png"));
  console.log("  feature-graphic.png");

  console.log("All icons generated!");
}

generate().catch(console.error);
