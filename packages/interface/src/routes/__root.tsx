import type {QueryClient} from '@tanstack/react-query';
import {createRootRouteWithContext, Outlet} from '@tanstack/react-router';
import {z} from 'zod';

import type {Application} from '../application/controller';
import ApplicationShell from '../components/applicationShell/applicationShell';

interface RouterContext {
  queryClient: QueryClient;
  application: Application;
}

function RootLayout() {
  const {application} = Route.useRouteContext();
  return (
    <ApplicationShell application={application}>
      <Outlet />
    </ApplicationShell>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: z.object({q: z.string().optional().catch(undefined)}),
  component: RootLayout,
});
