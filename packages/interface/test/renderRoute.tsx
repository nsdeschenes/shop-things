import {QueryClientProvider} from '@tanstack/react-query';
import {createMemoryHistory, createRouter, RouterProvider} from '@tanstack/react-router';
import {render} from '@testing-library/react';

import {AppearanceProvider} from '../src/application/appearance';
import {createApplication} from '../src/application/controller';
import {routeTree} from '../src/routeTree.gen';

export default function renderRoute(
  path: string,
  application = createApplication('http://localhost/?preview=true', false)
) {
  void application.start();
  const queryClient = application.queryClient;
  const router = createRouter({
    routeTree,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    history: createMemoryHistory({initialEntries: [path]}),
    context: {queryClient, application},
  });

  render(
    <AppearanceProvider initialPreference="system">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppearanceProvider>
  );

  return {router, application};
}
