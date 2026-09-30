/* oxlint-disable import/no-named-export -- Shared route feedback components. */
import {Link, useRouter, type ErrorComponentProps} from '@tanstack/react-router';

import {CustomerRequestError} from '../../application/customers';
import Button from '../button/button';
import LoadingOverlay from '../loadingOverlay/loadingOverlay';
import PageShell from '../pageShell/pageShell';

export function CustomerRouteError({error}: ErrorComponentProps) {
  const router = useRouter();
  const missing =
    (error instanceof Error && error.cause instanceof RangeError) ||
    (error instanceof CustomerRequestError && error.error.code === 'CUSTOMER_DELETED');
  const message =
    error instanceof Error ? error.message : 'Could not load customers. Try again.';
  return (
    <PageShell
      title={missing ? 'Customer Not Found' : 'Could Not Load Customers'}
      actions={<Link to="/customers">Back to customers</Link>}
    >
      <section role="alert">
        <p>{missing ? 'This customer no longer exists.' : message}</p>
        {!missing && (
          <Button
            onClick={() => {
              void router.invalidate();
            }}
          >
            Retry
          </Button>
        )}
      </section>
    </PageShell>
  );
}

export function CustomerRoutePending() {
  return <LoadingOverlay label="Loading customers…" />;
}
