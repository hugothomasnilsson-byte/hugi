import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Relative base so the build works from any sub-path (e.g. GitHub Pages /hugi/).
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'Syble — a personal almanac',
        short_name: 'Syble',
        description: 'A private, offline library of your sources, references and inspiration.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f6f4ef',
        theme_color: '#f6f4ef',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache everything, including the OCR engine and language data,
        // so the installed app never needs the network.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm,gz,webmanifest}'],
        // Optional OCR languages are not part of the install; each is cached from
        // this same origin the first time it is turned on in Library.
        globIgnores: ['**/tesseract/lang/!(eng).traineddata.gz'],
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.includes('/tesseract/lang/'),
            handler: 'CacheFirst',
            options: { cacheName: 'syble-ocr-languages' },
          },
        ],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
  },
});
