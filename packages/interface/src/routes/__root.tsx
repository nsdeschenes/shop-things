import type {QueryClient} from '@tanstack/react-query';
import {createRootRouteWithContext, Outlet} from '@tanstack/react-router';

import type {Application} from '../application/controller';
import {waitForApplication} from '../application/routing';
import ApplicationShell from '../components/applicationShell/applicationShell';
import {CustomerRoutePending} from '../components/customerRouteFeedback/customerRouteFeedback';

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
  beforeLoad: ({context}) => waitForApplication(context.application),
  pendingComponent: CustomerRoutePending,
  pendingMs: 0,
  component: RootLayout,
});
