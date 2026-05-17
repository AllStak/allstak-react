import { useEffect, useState } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  useNavigate,
  useLocation,
} from 'react-router-dom';
import { AllStak, AllStakProvider, instrumentReactRouter } from '@allstak/react';

// Hardcoded for verification / dev only — production apps must use the
// public ingest host.
const ALLSTAK_API_KEY = 'ask_react_verify_5673c93319c6a687899ab9d5be5c132c';
const ALLSTAK_HOST = 'http://localhost:8080';

// Set true to auto-fire the verification flow on mount.
const DEV_AUTO_FIRE = true;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function CrashingChild(): React.ReactElement {
  throw new Error('CrashingChild render error');
}

function CrashOnDemand(): React.ReactElement {
  const [crash, setCrash] = useState(false);
  if (crash) return <CrashingChild />;
  return <button onClick={() => setCrash(true)}>Trigger render-time error</button>;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ marginBottom: 16 }}>
      <legend>{label}</legend>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </fieldset>
  );
}

function RouterInstrumentation(): null {
  const location = useLocation();
  useEffect(() => {
    instrumentReactRouter(location);
  }, [location]);
  return null;
}

function HomeScreen(): React.ReactElement {
  const navigate = useNavigate();
  return (
    <div className="screen">
      <h2>Home</h2>
      <p>AllStak React verification sample. Tap a button to fire SDK paths.</p>

      <Section label="Manual capture">
        <button onClick={() => AllStak.captureException(new Error('manual button press'))}>captureException</button>
        <button onClick={() => AllStak.captureMessage('Home info log', 'info')}>captureMessage info</button>
        <button onClick={() => AllStak.captureMessage('Home error log', 'error')}>captureMessage error</button>
      </Section>

      <Section label="Auto capture">
        <button onClick={() => console.warn('warning from Home', { tab: 'home' })}>console.warn</button>
        <button onClick={() => console.error('error from Home', { tab: 'home' })}>console.error</button>
        <button onClick={() => fetch('https://httpbin.org/status/200').catch(() => {})}>fetch 200</button>
        <button onClick={() => fetch('https://httpbin.org/status/404').catch(() => {})}>fetch 404</button>
        <button onClick={() => fetch('https://httpbin.org/status/500').catch(() => {})}>fetch 500</button>
        <button onClick={() => fetch('https://no-such-host-allstak-test.invalid/').catch(() => {})}>fetch network failure</button>
        <button onClick={() => Promise.reject(new Error('unhandled-rejection from Home'))}>unhandled rejection</button>
        <button onClick={() => setTimeout(() => { throw new Error('uncaught timeout error'); }, 0)}>window.onerror (delayed throw)</button>
      </Section>

      <Section label="Navigation">
        <button onClick={() => navigate('/products')}>Go to Products</button>
        <button onClick={() => navigate('/profile')}>Go to Profile</button>
      </Section>

      <Section label="Render error">
        <CrashOnDemand />
      </Section>
    </div>
  );
}

function ProductsScreen(): React.ReactElement {
  const navigate = useNavigate();
  return (
    <div className="screen">
      <h2>Products</h2>
      <button onClick={() => navigate('/profile')}>Go to Profile</button>
      <Link to="/">Back to Home</Link>
      <button onClick={() => AllStak.captureException(new Error('error from Products'))}>Capture exception</button>
    </div>
  );
}

function ProfileScreen(): React.ReactElement {
  return (
    <div className="screen">
      <h2>Profile</h2>
      <Link to="/">Back to Home</Link>
      <Link to="/products">Back to Products</Link>
    </div>
  );
}

function AutoFireHarness(): null {
  const navigate = useNavigate();
  useEffect(() => {
    if (!DEV_AUTO_FIRE) return;
    const fire = async () => {
      console.log('[verify] === starting verification harness ===');

      try {
        const r = await fetch(ALLSTAK_HOST + '/actuator/health');
        console.log('[verify] backend health', r.status);
      } catch (e: any) {
        console.log('[verify] health FAILED', e?.message);
      }

      console.log('[verify] firing captureException #1');
      AllStak.captureException(new Error('react-sample: manual exception #1'));
      await AllStak.flush(5000);

      console.log('[verify] firing captureMessage info');
      AllStak.captureMessage('react-sample: manual info log', 'info');
      await delay(120);
      console.log('[verify] firing captureMessage error');
      AllStak.captureMessage('react-sample: manual error log', 'error');
      await delay(120);

      console.log('[verify] navigating Home -> Products -> Profile -> Home');
      navigate('/products'); await delay(150);
      navigate('/profile');  await delay(150);
      navigate('/');         await delay(200);

      console.log('[verify] firing console calls');
      console.log('react-sample: log line — should NOT appear in breadcrumbs');
      console.info('react-sample: info line — should NOT appear in breadcrumbs');
      console.warn('react-sample: warn line — SHOULD land at level=warn', { from: 'harness' });
      console.error('react-sample: error line — SHOULD land at level=error', { from: 'harness' });
      await delay(150);

      console.log('[verify] firing fetch breadcrumbs');
      try { await fetch('https://httpbin.org/status/200'); } catch {}
      try { await fetch('https://httpbin.org/status/404'); } catch {}
      try { await fetch('https://httpbin.org/status/500'); } catch {}
      try { await fetch('https://no-such-host-allstak-test.invalid/'); } catch {}
      await delay(200);

      console.log('[verify] firing unhandled rejection');
      Promise.reject(new Error('react-sample: unhandled rejection from harness'));
      await delay(300);

      console.log('[verify] firing window.onerror via setTimeout');
      setTimeout(() => { throw new Error('react-sample: window.onerror from harness'); }, 0);
      await delay(300);

      console.log('[verify] firing final exception with breadcrumbs');
      AllStak.captureException(new Error('react-sample: final exception with breadcrumbs'));
      const flushed = await AllStak.flush(5000);
      console.log('[verify] final flushed:', flushed);
      console.log('[verify] === harness complete ===');
    };
    const t = setTimeout(() => { fire().catch(e => console.log('[verify] harness err', e)); }, 600);
    return () => clearTimeout(t);
  }, [navigate]);
  return null;
}

export default function App(): React.ReactElement {
  return (
    <AllStakProvider
      apiKey={ALLSTAK_API_KEY}
      host={ALLSTAK_HOST}
      environment="development"
      release="react-test@1.0.0"
      debug
      enableHttpTracking
      httpTracking={{ ignoredUrls: [/actuator/] }}
      captureConsole={{ log: false, info: false, warn: true, error: true }}
      autoWebVitals
      fallback={({ error, resetError }) => (
        <div style={{
          padding: 24, background: '#fff5f5', color: '#900',
          minHeight: '100vh', textAlign: 'center',
        }}>
          <h2 style={{ color: '#c00' }}>Render error caught</h2>
          <p>{error.message}</p>
          <button onClick={resetError}>Try again</button>
        </div>
      )}
      onError={(error) => console.log('[sample] onError fired:', error.message)}
    >
      <BrowserRouter>
        <RouterInstrumentation />
        <AutoFireHarness />
        <header style={{ padding: 12, borderBottom: '1px solid #eee' }}>
          <Link to="/" style={{ marginRight: 12 }}>Home</Link>
          <Link to="/products" style={{ marginRight: 12 }}>Products</Link>
          <Link to="/profile">Profile</Link>
        </header>
        <main style={{ padding: 16, maxWidth: 720, margin: '0 auto' }}>
          <Routes>
            <Route path="/" element={<HomeScreen />} />
            <Route path="/products" element={<ProductsScreen />} />
            <Route path="/profile" element={<ProfileScreen />} />
          </Routes>
        </main>
      </BrowserRouter>
    </AllStakProvider>
  );
}
