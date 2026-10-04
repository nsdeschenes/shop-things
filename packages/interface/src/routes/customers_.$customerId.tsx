import type {CustomerRecord} from '@shop-things/contract';
import * as stylex from '@stylexjs/stylex';
import {isCancelledError, useQuery} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {useEffect, useState, useSyncExternalStore} from 'react';

import {CustomerRequestError, customerDetailOptions} from '../application/customers';
import {admitCustomerRoute} from '../application/routing';
import Button from '../components/button/button';
import buttonStyles from '../components/button/buttonStyles';
import CustomerForm from '../components/customerForm/customerForm';
import {
  CustomerRouteError,
  CustomerRoutePending,
} from '../components/customerRouteFeedback/customerRouteFeedback';
import PageShell from '../components/pageShell/pageShell';

const customerIdPattern = /^\d+$/;

export const Route = createFileRoute('/customers_/$customerId')({
  params: {
    parse: params => {
      const id = Number(params.customerId);
      if (
        !customerIdPattern.test(params.customerId) ||
        !Number.isSafeInteger(id) ||
        id <= 0
      ) {
        throw new RangeError('This customer no longer exists.');
      }

      return params;
    },
  },
  beforeLoad: admitCustomerRoute,
  loader: async ({context: {application, queryClient, session, readScope}, params}) => {
    if (session && readScope) {
      await queryClient.fetchQuery(
        customerDetailOptions(application, session, Number(params.customerId), readScope)
      );
    }
  },
  pendingComponent: CustomerRoutePending,
  errorComponent: CustomerRouteError,
  remountDeps: ({params}) => params.customerId,
  component: RouteComponent,
});

function RouteComponent() {
  const {application} = Route.useRouteContext();
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const protection = useSyncExternalStore(
    application.protection.subscribe,
    application.protection.getState
  );
  const [editing, setEditing] = useState<CustomerRecord | null>(null);
  useEffect(
    () =>
      application.onSessionChanged(() => {
        setEditing(null);
      }),
    [application]
  );
  const {customerId} = Route.useParams();
  const id = Number(customerId);
  const session = state.database?.session ?? '';
  const available = state.database?.available === true && !state.recoveryRequired;
  const disabled =
    !available || state.pendingTransition || state.reconciling || protection.frozen;
  const record = useQuery({
    ...customerDetailOptions(application, session, id),
    enabled: !disabled,
  });
  const missing =
    record.error instanceof CustomerRequestError &&
    record.error.error.code === 'CUSTOMER_DELETED';
  const customer = record.data?.customer;
  const back = (
    <Link to="/customers" {...stylex.props(buttonStyles.base)}>
      Back to customers
    </Link>
  );

  // Capture once so refreshes and outages cannot replace an active draft.
  if (!editing && record.data) {
    setEditing(structuredClone(record.data));
  }

  if (editing && editing.customer.id === id) {
    return (
      <CustomerForm
        key={`${editing.reference.session}:${editing.customer.id}`}
        application={application}
        session={editing.reference.session}
        initialRecord={editing}
      />
    );
  }

  if (missing) {
    return (
      <PageShell title="Customer Not Found" back={back}>
        <p>This customer no longer exists.</p>
      </PageShell>
    );
  }

  if (!available) {
    return (
      <PageShell title="Customer" back={back}>
        <p role="alert">
          {state.error ??
            'The database is unavailable. Open or retry the database to continue.'}
        </p>
      </PageShell>
    );
  }

  if (
    record.isPending ||
    isCancelledError(record.error) ||
    (!customer && !record.isError)
  ) {
    return (
      <PageShell title="Customer" back={back}>
        <p role="status">Loading customer…</p>
      </PageShell>
    );
  }

  if (record.isError) {
    return (
      <PageShell title="Customer" back={back}>
        <section role="alert">
          <p>{record.error.message}</p>
          <Button
            disabled={disabled}
            onClick={() => {
              void record.refetch();
            }}
          >
            Retry
          </Button>
        </section>
      </PageShell>
    );
  }

  return null;
}
