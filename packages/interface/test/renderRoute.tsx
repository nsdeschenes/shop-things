import {QueryClientProvider} from '@tanstack/react-query';
import {createMemoryHistory, createRouter, RouterProvider} from '@tanstack/react-router';
import {render} from '@testing-library/react';

import {createApplication} from '../src/application/controller';
import {routeTree} from '../src/routeTree.gen';

export default function renderRoute(path: string) {
  const application = createApplication('http://localhost/?preview=true', false);
  void application.start();
  const queryClient = application.queryClient;
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({initialEntries: [path]}),
    context: {queryClient, application},
  });

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );

  return {router};
}
