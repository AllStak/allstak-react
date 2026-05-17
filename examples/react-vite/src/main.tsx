import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AllStak, AllStakErrorBoundary } from '@allstak/react';
import App from './App';

// ── Initialise the SDK once, before rendering ──────────────────────
AllStak.init({
  apiKey: import.meta.env.VITE_ALLSTAK_API_KEY ?? 'demo-key',
  host: import.meta.env.VITE_ALLSTAK_HOST ?? 'https://api.allstak.sa',
  environment: import.meta.env.MODE, // "development" | "production"
});

// ── Render ─────────────────────────────────────────────────────────
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AllStakErrorBoundary
      fallback={
        <div style={{ padding: 32, fontFamily: 'system-ui' }}>
          <h1>Something went wrong</h1>
          <p>The error has been reported to AllStak.</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      }
    >
      <App />
    </AllStakErrorBoundary>
  </StrictMode>,
);
