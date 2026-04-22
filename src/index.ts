/**
 * @allstak-io/react — React-specific public API.
 *
 * Re-exports the React integration from @allstak-io/allstak-js/react.
 * Components and hooks all rely on @allstak-io/browser being initialized first.
 */
export {
  AllStakErrorBoundary,
  type AllStakErrorBoundaryProps,
  useAllStak,
  withAllStakProfiler,
  AllStak,
} from '@allstak-io/allstak-js/react';
