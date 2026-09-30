import * as stylex from '@stylexjs/stylex';
import {QueryClientProvider} from '@tanstack/react-query';
import {RouterProvider, createRouter} from '@tanstack/react-router';
import {StrictMode} from 'react';
import ReactDOM from 'react-dom/client';

import {createApplication} from './application/controller';
import createApplicationHistory from './application/history';
import {routeTree} from './routeTree.gen';
import {typography} from './styles/typography.stylex';

import './index.css';

const styles = stylex.create({
  body: {
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSizeBody,
  },
});

document.body.classList.add(...(stylex.props(styles.body).className?.split(' ') ?? []));

const application = createApplication(window.location.href);
const queryClient = application.queryClient;
void application.start();
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

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Render the app
const rootElement = document.getElementById('root')!;
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>
  );
}
