import type {QueryClient} from '@tanstack/react-query';
import {createRootRouteWithContext, Outlet, useRouter} from '@tanstack/react-router';

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

function RootPending() {
  const {application} = useRouter().options.context!;
  return (
    <ApplicationShell application={application}>
      <CustomerRoutePending />
    </ApplicationShell>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: ({context}) => waitForApplication(context.application),
  pendingComponent: RootPending,
  pendingMs: 0,
  component: RootLayout,
});
