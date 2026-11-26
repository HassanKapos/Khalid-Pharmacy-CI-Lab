import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('========================================================================');
console.log('🛡️ KHALID PHARMACY — PHASE 1M.11-P5 CAMERA VIEWPORT ISOLATION TEST');
console.log('========================================================================\n');

// 1. Verify CSS Rules in src/index.css
const cssPath = path.join(rootDir, 'src', 'index.css');
const cssContent = fs.readFileSync(cssPath, 'utf8');

assert(cssContent.includes('body.barcode-scanner-active #app'), 'index.css includes body.barcode-scanner-active #app rule');
assert(cssContent.includes('visibility: hidden !important;'), 'index.css hides #app during native scan via visibility: hidden !important');
assert(cssContent.includes('box-shadow: 0 0 0 9999px rgba(2, 6, 23, 0.88);'), 'index.css uses elegant dark rgba(2, 6, 23, 0.88) vignette shadow for viewfinder cutout');

console.log('✓ PASS 1: CSS isolation rules verified in src/index.css');

// 2. Verify HUD append logic in mlKitPocService.ts
const mlKitServicePath = path.join(rootDir, 'src', 'services', 'mlKitPocService.ts');
const mlKitContent = fs.readFileSync(mlKitServicePath, 'utf8');

assert(mlKitContent.includes("document.body.appendChild(overlay);"), 'mlKitPocService appends HUD overlay directly to document.body');
assert(mlKitContent.includes("overlay.id = 'mlkit-poc-overlay';"), 'mlKitPocService sets overlay.id to mlkit-poc-overlay');
assert(mlKitContent.includes('bg-slate-900/95 border-b'), 'mlKitPocService top action bar uses Slate 900 high contrast container');
assert(mlKitContent.includes('bg-slate-900/95 border-t'), 'mlKitPocService bottom diagnostics card uses Slate 900 high contrast container');

console.log('✓ PASS 2: HUD structure & DOM placement verified in src/services/mlKitPocService.ts');

// 3. Verify Web ZXing backdrop in index.html
const indexHtmlPath = path.join(rootDir, 'index.html');
const indexHtmlContent = fs.readFileSync(indexHtmlPath, 'utf8');

assert(indexHtmlContent.includes('bg-slate-950/95 sm:bg-slate-950/90'), 'index.html uses dense opaque backdrop for Web ZXing scanner modal');

console.log('✓ PASS 3: Web ZXing modal backdrop isolation verified in index.html');

console.log('\n========================================================================');
console.log('ALL PHASE 1M.11-P5 ISOLATION ASSERTONS PASSED SUCCESSFULLY (100%)');
console.log('========================================================================');
