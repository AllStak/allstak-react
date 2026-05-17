import React from 'react';

/**
 * Component that throws during render.
 * Used to verify the AllStakErrorBoundary catches render-phase errors.
 */
export default function ErrorDemo(): React.ReactElement {
  throw new Error('ErrorDemo: render-phase explosion (caught by ErrorBoundary)');
}
