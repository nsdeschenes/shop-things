import {defaultTelemetrySampling} from '@shop-things/contract/schemas';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {expect, test, vi} from 'vitest';

import {initializeRendererTelemetry} from './telemetry';

test('React render errors remain visible locally when monitoring is disabled', () => {
  const {reportReactError} = initializeRendererTelemetry(
    null,
    defaultTelemetrySampling,
    'development'
  );
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const error = new Error('Render failed');
  function BrokenView(): never {
    throw error;
  }

  const element = document.createElement('div');
  const root = createRoot(element, {
    onCaughtError: reportReactError,
    onUncaughtError: reportReactError,
    onRecoverableError: reportReactError,
  });
  try {
    flushSync(() => root.render(<BrokenView />));
    expect(logged).toHaveBeenCalledWith(error);
  } finally {
    flushSync(() => root.unmount());
    logged.mockRestore();
  }
});
