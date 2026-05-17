# AllStak React SDK — Vite Example

Minimal Vite + React + TypeScript app demonstrating `@allstak/react` integration.

## Setup

```bash
# 1. Install dependencies (links the parent SDK automatically)
npm install

# 2. Copy the env file and add your API key
cp .env.example .env

# 3. Start the dev server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## What Each Button Does

| Button | Behaviour |
|---|---|
| **Trigger Unhandled Error** | Renders a component that throws during render. The `AllStakErrorBoundary` catches it, reports the error to AllStak, and shows the fallback UI. |
| **Trigger Caught Error** | Wraps a JSON.parse call in try/catch and sends the error via `AllStak.captureException()`. |
| **Trigger Promise Rejection** | Creates an unhandled `Promise.reject()`. The SDK's global `unhandledrejection` listener captures it. |
| **Add Breadcrumb** | Calls `AllStak.addBreadcrumb()` to attach context. Breadcrumbs appear on the next captured error. |
| **Trigger Console Error** | Calls `console.error()`. The SDK auto-captures console errors as breadcrumbs. |

## Source Maps

Production builds include source maps. To upload them to AllStak for readable stack traces, set `ALLSTAK_UPLOAD_TOKEN` before building:

```bash
ALLSTAK_UPLOAD_TOKEN=your-token npm run build
```

The Vite plugin (`@allstak/react/vite`) handles injection and upload automatically.
