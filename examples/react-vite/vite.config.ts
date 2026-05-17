import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { allstakSourcemaps } from '@allstak/react/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    allstakSourcemaps({
      // Uploads source maps on production builds so AllStak can show
      // original source in stack traces. Requires ALLSTAK_UPLOAD_TOKEN.
      token: process.env.ALLSTAK_UPLOAD_TOKEN,
      release: process.env.npm_package_version,
      disabled: !process.env.ALLSTAK_UPLOAD_TOKEN,
    }),
  ],
  build: {
    sourcemap: true,
  },
});
