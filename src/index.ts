/**
 * @allstak/react — React-specific public API.
 *
 * Re-exports the React integration from @allstak/js/react.
 * Components and hooks all rely on @allstak/browser being initialized first.
 */
export {
  AllStakErrorBoundary,
  type AllStakErrorBoundaryProps,
  useAllStak,
  withAllStakProfiler,
  AllStak,
} from '@allstak/js/react';
