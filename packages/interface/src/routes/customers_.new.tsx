import {createFileRoute} from '@tanstack/react-router';
import {useState, useSyncExternalStore} from 'react';

import CustomerForm from '../components/customerForm/customerForm';
import PageShell from '../components/pageShell/pageShell';
export const Route = createFileRoute('/customers_/new')({component: RouteComponent});
function RouteComponent() {
  const {application} = Route.useRouteContext();
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const [session, setSession] = useState<string | null>(null);
  // Mount the editor only for an admitted session, then retain it through unavailability.
  if (!session && state.database?.available && state.database.session) {
    setSession(state.database.session);
  }

  return session ? (
    <CustomerForm application={application} session={session} />
  ) : (
    <PageShell title="New Customer">
      <p>The database is unavailable.</p>
    </PageShell>
  );
}
