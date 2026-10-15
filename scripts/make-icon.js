// One-off generator for media/icon.png (128x128 Marketplace icon).
// Renders a rounded-square brand badge with the LPilot robot glyph in white.
const sharp = require('sharp');
const path = require('path');

const glyph = `
  <g transform="translate(16 22.2) scale(4)" fill="none" stroke="#ffffff"
     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="5" y="8" width="14" height="10" rx="2.5" />
    <circle cx="9.5" cy="13" r="1.3" fill="#ffffff" stroke="none" />
    <circle cx="14.5" cy="13" r="1.3" fill="#ffffff" stroke="none" />
    <path d="M12 8V5.5" />
    <circle cx="12" cy="4.2" r="1.3" fill="#ffffff" stroke="none" />
    <path d="M5 11.5H3.5M20.5 11.5H19" />
    <path d="M9.5 15.8h5" />
  </g>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7C3AED" />
      <stop offset="1" stop-color="#2563EB" />
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="128" height="128" rx="28" fill="url(#bg)" />
  ${glyph}
</svg>`;

async function main() {
  const out = path.join(__dirname, '..', 'media', 'icon.png');
  await sharp(Buffer.from(svg))
    .resize(128, 128)
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log('wrote', out);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
