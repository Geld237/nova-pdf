import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// `base: './'` permet de servir l'app depuis n'importe quel sous-dossier (GitHub Pages).
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Nova PDF',
        short_name: 'Nova PDF',
        description: 'Lecteur PDF libre, rapide et privé, avec IA locale.',
        theme_color: '#3d52d5',
        background_color: '#f4f5f8',
        display: 'standalone',
        start_url: './',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
        // Permet « Ouvrir avec Nova PDF » une fois l'app installée (Chrome/Edge)
        file_handlers: [{ action: './', accept: { 'application/pdf': ['.pdf'] } }],
      } as Record<string, unknown>,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,mjs,wasm}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
      },
    }),
  ],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
