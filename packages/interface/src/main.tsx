import {Toast} from '@base-ui/react/toast';
import {getClient} from '@shop-things/contract/client';
import {defaultTelemetrySampling} from '@shop-things/contract/schemas';
import * as stylex from '@stylexjs/stylex';
import {QueryClientProvider} from '@tanstack/react-query';
import {RouterProvider, createRouter} from '@tanstack/react-router';
import {StrictMode} from 'react';
import ReactDOM from 'react-dom/client';

import {AppearanceProvider, initializeAppearance} from './application/appearance';
import {createApplication} from './application/controller';
import createApplicationHistory from './application/history';
import {initializeRendererTelemetry} from './application/telemetry';
import toastManager from './application/toasts';
import Toasts from './components/toasts/toasts';
import {routeTree} from './routeTree.gen';
import {typography} from './styles/typography.stylex';
import './styles/breakpoints.stylex';

import './index.css';

const styles = stylex.create({
  body: {
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSizeBody,
  },
});

const initialAppearance = initializeAppearance();

document.body.classList.add(...(stylex.props(styles.body).className?.split(' ') ?? []));

let bridge: ReturnType<typeof getClient> | null = null;
try {
  if (Reflect.has(window, 'shopThings')) {
    bridge = getClient();
  }
} catch {}

const configuration = await bridge?.telemetry.status();
const activeDsn =
  configuration?.status === 'success' ? configuration.value.activeDsn : null;
const connectionPolicy = document.createElement('meta');
connectionPolicy.httpEquiv = 'Content-Security-Policy';
const connectionSources = [
  ...(import.meta.env.DEV ? ["'self'"] : []),
  ...(activeDsn ? [new URL(activeDsn).origin] : []),
];
connectionPolicy.content = `connect-src ${connectionSources.join(' ') || "'none'"}`;
document.head.append(connectionPolicy);
const monitoring = initializeRendererTelemetry(
  activeDsn,
  configuration?.status === 'success'
    ? configuration.value.activeSampling
    : defaultTelemetrySampling,
  configuration?.status === 'success' ? configuration.value.environment : 'development'
);
try {
  if (bridge) {
    bridge = getClient(monitoring.observe);
  }
} catch {
  bridge = null;
}

const application = createApplication(
  window.location.href,
  undefined,
  bridge ? {client: bridge} : {}
);
const queryClient = application.queryClient;
window.addEventListener('pagehide', () => application.dispose());
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    void application.start();
  }
});

const router = createRouter({
  history: createApplicationHistory(),
  routeTree,
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  context: {
    queryClient,
    application,
  },
});

monitoring.instrumentRouter(router);
void application.start();
router.subscribe('onResolved', () => {
  for (const match of router.state.matches) {
    if (match.status === 'error') {
      monitoring.captureException(match.error);
    }
  }
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById('root')!;
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement, {
    onCaughtError: monitoring.reportReactError,
    onUncaughtError: monitoring.reportReactError,
    onRecoverableError: monitoring.reportReactError,
  });
  root.render(
    <StrictMode>
      <AppearanceProvider initialPreference={initialAppearance}>
        <Toast.Provider toastManager={toastManager}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
          <Toasts />
        </Toast.Provider>
      </AppearanceProvider>
    </StrictMode>
  );
}
