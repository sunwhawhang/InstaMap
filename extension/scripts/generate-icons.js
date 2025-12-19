#!/usr/bin/env node

/**
 * Simple script to remind you to generate PNG icons from the SVG
 * 
 * You can use online tools or command-line tools:
 * 
 * Option 1: Use an online converter
 * - https://cloudconvert.com/svg-to-png
 * - https://svgtopng.com/
 * 
 * Option 2: Use ImageMagick (if installed)
 * ```
 * convert -background none -resize 16x16 public/icons/icon.svg public/icons/icon16.png
 * convert -background none -resize 48x48 public/icons/icon.svg public/icons/icon48.png
 * convert -background none -resize 128x128 public/icons/icon.svg public/icons/icon128.png
 * ```
 * 
 * Option 3: Use sharp (Node.js)
 * ```
 * npm install sharp
 * ```
 * Then run this script.
 */

console.log(`
╔════════════════════════════════════════════════════════════╗
║                    InstaMap Icons                           ║
╠════════════════════════════════════════════════════════════╣
║                                                             ║
║  To generate PNG icons from the SVG:                        ║
║                                                             ║
║  1. Open public/icons/icon.svg in a browser or editor       ║
║                                                             ║
║  2. Export as PNG at these sizes:                           ║
║     - 16x16  → icon16.png                                   ║
║     - 48x48  → icon48.png                                   ║
║     - 128x128 → icon128.png                                 ║
║                                                             ║
║  Or use ImageMagick:                                        ║
║  convert -background none -resize 16x16 icon.svg icon16.png ║
║                                                             ║
╚════════════════════════════════════════════════════════════╝
`);

// If sharp is available, generate icons automatically
try {
  const sharp = require('sharp');
  const path = require('path');
  
  const sizes = [16, 48, 128];
  const inputPath = path.join(__dirname, '../public/icons/icon.svg');
  
  sizes.forEach(async (size) => {
    const outputPath = path.join(__dirname, `../public/icons/icon${size}.png`);
    await sharp(inputPath)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`Generated: icon${size}.png`);
  });
} catch (e) {
  console.log('Note: Install sharp (npm i sharp) to auto-generate icons');
}
