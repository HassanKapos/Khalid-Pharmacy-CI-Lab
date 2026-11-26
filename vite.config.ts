import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'path';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import { collectBuildProvenance, formatAssetManifest } from './scripts/build-manifest-provenance.mjs';

// Explicitly authorized non-runtime AI Studio capture/paste files excluded from production dist/Android output only.
// Original files remain preserved in public/assets/aistudio/.
const EXCLUDED_NON_RUNTIME_PUBLIC_ASSETS = [
  'assets/aistudio/Paste_November_17__2026_-_12_57AM_0a6b2601',
  'assets/aistudio/Screen_Recording____________________Khalid_Pharmacy_a8a11894.mp4',
] as const;

function collectDistFiles(dir: string, rootDir: string, out: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectDistFiles(full, rootDir, out);
    } else if (entry.isFile()) {
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      if (rel !== 'MANIFEST.txt') {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

function khalidBuildOutputSanitizer(): Plugin {
  let resolvedConfig: ResolvedConfig | null = null;
  return {
    name: 'khalid-build-output-sanitizer',
    apply: 'build',
    configResolved(config) {
      resolvedConfig = config;
    },
    closeBundle() {
      const rootDir = resolvedConfig?.root || path.resolve('.');
      const outDir = path.resolve(rootDir, resolvedConfig?.build?.outDir || 'dist');
      if (!fs.existsSync(outDir)) return;

      for (const rel of EXCLUDED_NON_RUNTIME_PUBLIC_ASSETS) {
        const target = path.resolve(outDir, rel);
        if (target.startsWith(outDir + path.sep) && fs.existsSync(target)) {
          fs.rmSync(target, { force: true });
        }
      }

      const files = collectDistFiles(outDir, outDir);
      const provenance = collectBuildProvenance(rootDir);
      const manifestText = formatAssetManifest({
        files,
        outDir,
        provenance,
        excludedCount: EXCLUDED_NON_RUNTIME_PUBLIC_ASSETS.length,
      });

      fs.writeFileSync(path.join(outDir, 'MANIFEST.txt'), manifestText, 'utf8');
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), khalidBuildOutputSanitizer()],
    resolve: {
      alias: {
        '@': path.resolve('.'),
        vue: 'vue/dist/vue.esm-bundler.js',
      },
    },
    build: {
      target: 'es2020',
      minify: 'esbuild',
      cssCodeSplit: true,
      chunkSizeWarningLimit: 500,
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes('node_modules')) {
              if (id.includes('vue')) {
                return 'vendor-vue';
              }
              if (id.includes('lucide')) {
                return 'vendor-icons';
              }
              return 'vendor-deps';
            }
          },
        },
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
