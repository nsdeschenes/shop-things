import {createFileRoute} from '@tanstack/react-router';
import {useState} from 'react';

import {admitCustomerRoute} from '../application/routing';
import CustomerForm from '../components/customerForm/customerForm';
import PageShell from '../components/pageShell/pageShell';
export const Route = createFileRoute('/customers_/new')({
  beforeLoad: admitCustomerRoute,
  component: RouteComponent,
});
function RouteComponent() {
  const {application, session: admittedSession} = Route.useRouteContext();
  // Retain the admitted session through database outages.
  const [session] = useState(admittedSession);

  return session ? (
    <CustomerForm application={application} session={session} />
  ) : (
    <PageShell title="New Customer">
      <p>The database is unavailable.</p>
    </PageShell>
  );
}
