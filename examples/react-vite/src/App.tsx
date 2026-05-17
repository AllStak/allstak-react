import { useState } from 'react';
import { AllStak } from '@allstak/react';
import ErrorDemo from './ErrorDemo';

export default function App() {
  const [showBomb, setShowBomb] = useState(false);

  // ── Action handlers ────────────────────────────────────────────
  function triggerCaughtError() {
    try {
      JSON.parse('not json!!!');
    } catch (err) {
      AllStak.captureException(err as Error, {
        source: 'triggerCaughtError button',
      });
      alert('Caught error sent to AllStak (check console).');
    }
  }

  function triggerPromiseRejection() {
    // Intentional unhandled rejection — the SDK's global listener picks it up.
    Promise.reject(new Error('Unhandled promise rejection demo'));
  }

  function addBreadcrumb() {
    AllStak.addBreadcrumb(
      'ui.click',
      'User clicked the Add Breadcrumb button',
      'info',
    );
    alert('Breadcrumb added. Trigger an error to see it attached.');
  }

  function triggerConsoleError() {
    // eslint-disable-next-line no-console
    console.error('Console error demo — AllStak captures this as a breadcrumb');
  }

  // ── Render ─────────────────────────────────────────────────────
  if (showBomb) return <ErrorDemo />;

  return (
    <div style={{ padding: 32, fontFamily: 'system-ui', maxWidth: 600 }}>
      <h1>AllStak React SDK — Vite Example</h1>
      <p style={{ color: '#666' }}>
        Click the buttons below to test error tracking, breadcrumbs, and the
        error boundary. Open the browser console to see SDK debug output.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24 }}>
        <Button onClick={() => setShowBomb(true)} color="#e74c3c">
          Trigger Unhandled Error (ErrorBoundary)
        </Button>

        <Button onClick={triggerCaughtError} color="#e67e22">
          Trigger Caught Error (captureException)
        </Button>

        <Button onClick={triggerPromiseRejection} color="#9b59b6">
          Trigger Promise Rejection
        </Button>

        <Button onClick={addBreadcrumb} color="#2980b9">
          Add Breadcrumb
        </Button>

        <Button onClick={triggerConsoleError} color="#27ae60">
          Trigger Console Error
        </Button>
      </div>
    </div>
  );
}

// ── Tiny styled button ─────────────────────────────────────────────
function Button({
  onClick,
  color,
  children,
}: {
  onClick: () => void;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '12px 20px',
        fontSize: 15,
        fontWeight: 600,
        color: '#fff',
        backgroundColor: color,
        border: 'none',
        borderRadius: 8,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
