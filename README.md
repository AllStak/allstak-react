# @allstak-io/react

AllStak React SDK — `<AllStakErrorBoundary>`, `useAllStak()` hook, and `withAllStakProfiler` HOC.

## Install

> **Auth required:** GitHub Packages requires a token with `read:packages` scope.

### 1. Configure `.npmrc`

```ini
@allstak-io:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

### 2. Install

```bash
npm install @allstak-io/react@0.1.1 @allstak-io/browser@0.1.1
# react >=16.8 is a peer dep — install separately if needed
```

## Usage

```tsx
import { AllStak } from '@allstak-io/browser';
import { AllStakErrorBoundary, useAllStak } from '@allstak-io/react';

// 1. Initialize once at app root
AllStak.init({
  apiKey: process.env.ALLSTAK_API_KEY!,
  environment: 'production',
  release: 'v1.0.0',
});

// 2. Wrap your component tree
function App() {
  return (
    <AllStakErrorBoundary fallback={<p>Something went wrong.</p>}>
      <MyApp />
    </AllStakErrorBoundary>
  );
}

// 3. Manual capture inside components
function MyComponent() {
  const allstak = useAllStak();

  const handleClick = () => {
    try {
      riskyOperation();
    } catch (err) {
      allstak.captureException(err as Error);
    }
  };

  return <button onClick={handleClick}>Do risky thing</button>;
}
```

## API

| Export | Description |
|--------|-------------|
| `AllStak` | Re-exported from `@allstak-io/browser` — use to init |
| `AllStakErrorBoundary` | React error boundary; catches component-tree errors |
| `AllStakErrorBoundaryProps` | Props type for the boundary |
| `useAllStak()` | Hook returning `{ captureException, captureMessage, setUser, setTag }` |
| `withAllStakProfiler(Component)` | HOC that wraps a component in the profiler |

## GitHub Packages

- **Package:** `@allstak-io/react`
- **Registry:** `https://npm.pkg.github.com`
- **Repo:** [github.com/allstak-io/allstak-react](https://github.com/allstak-io/allstak-react)
- **Releases:** [github.com/allstak-io/allstak-react/releases](https://github.com/allstak-io/allstak-react/releases)

## Versioning

Tags must match `package.json` version exactly (e.g. `v0.1.1`). The release workflow fails if there's a mismatch.
