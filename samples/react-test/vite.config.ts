import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { allstakSourcemaps } from '@allstak/react/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    allstakSourcemaps({
      // Local-only verification — these would be env vars in real apps:
      //   release: process.env.ALLSTAK_RELEASE,
      //   token: process.env.ALLSTAK_UPLOAD_TOKEN,
      //   dist: 'web',
      release: 'react-test@1.0.0',
      injectOnly: true,        // skip upload during the verification build
      silent: false,
    }),
  ],
  build: {
    sourcemap: true,           // emit .map files so the plugin has work to do
  },
});
