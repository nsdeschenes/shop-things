/* oxlint-disable @tanstack/query/exhaustive-deps -- Navigation scope controls admission, not review identity. */
import {createFileRoute, redirect} from '@tanstack/react-router';
import {useSyncExternalStore} from 'react';
import {z} from 'zod';

import {CustomerRequestError} from '../application/customers';
import {admitCustomerRoute} from '../application/routing';
import Button from '../components/button/button';
import {
  CustomerRouteError,
  CustomerRoutePending,
} from '../components/customerRouteFeedback/customerRouteFeedback';
import PageShell from '../components/pageShell/pageShell';

export const Route = createFileRoute('/customers_/import')({
  validateSearch: z.object({importId: z.string().optional()}),
  loaderDeps: ({search}) => ({importId: search.importId}),
  beforeLoad: admitCustomerRoute,
  loader: async ({context: {application, queryClient, session, readScope}, deps}) => {
    if (!deps.importId || !session) {
      throw redirect({to: '/customers'});
    }

    const importId = deps.importId;
    return queryClient.fetchQuery({
      // Navigation scope controls admission, not the session-bound review identity.
      queryKey: ['imports', session, importId],
      staleTime: Infinity,
      queryFn: async () => {
        const result = await application.read(
          session,
          client => client.imports.review({session, importId}),
          readScope
        );
        if (result.status === 'error') {
          throw new CustomerRequestError(result.error);
        }

        if (result.status !== 'success') {
          throw new Error('Could not load the import. Try again.');
        }

        return result.value;
      },
    });
  },
  pendingComponent: CustomerRoutePending,
  errorComponent: CustomerRouteError,
  component: ImportReview,
});

function ImportReview() {
  const review = Route.useLoaderData();
  const {application} = Route.useRouteContext();
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const navigate = Route.useNavigate();
  const expired =
    state.database?.available === true && state.database.session !== review.session;
  const disabled =
    Boolean(state.pendingFile) ||
    state.pendingTransition ||
    state.reconciling ||
    !state.database?.available ||
    expired;
  return (
    <PageShell
      title="Import Customers"
      actions={
        <Button
          disabled={Boolean(state.pendingFile)}
          onClick={() => {
            void navigate({to: '/customers'});
          }}
        >
          Cancel
        </Button>
      }
    >
      <p>Selected file: {review.fileName}</p>
      {expired ? (
        <p role="alert">This import expired. Choose the file again.</p>
      ) : !state.database?.available ? (
        <p role="alert">The database is unavailable. Your review is retained.</p>
      ) : null}
      {review.status === 'empty' && <p role="status">No customers to import</p>}
      {review.status === 'rejected' && (
        <section role="alert">
          <p>
            The file cannot be imported.{' '}
            {review.invalidRecordCount > 0 &&
              `${review.invalidRecordCount} invalid customer records.`}
          </p>
          <ul>
            {review.diagnostics.map((detail, index) => (
              <li key={index}>
                {detail.recordNumber === null ? '' : `Record ${detail.recordNumber}, `}
                {detail.column}: {detail.reason}
              </li>
            ))}
          </ul>
          {review.omittedDiagnosticCount > 0 && (
            <p>
              {review.omittedDiagnosticCount} additional details omitted. Showing the
              first 100 errors.
            </p>
          )}
        </section>
      )}
      <Button
        disabled={disabled}
        onClick={() => {
          void application.prepareImport().then(result => {
            if (result.status === 'success') {
              void navigate({search: {importId: result.value.importId}, replace: true});
            } else if (result.status === 'error') {
              application.toasts.error({title: result.error.message});
            }
          });
        }}
      >
        Choose another file
      </Button>
      {review.status === 'ready' && (
        <>
          <p role="status">
            {review.rows.length} source records. {review.numberChangeCount} customer
            numbers will change. No customers have been added.
          </p>
          <p>
            Unused source customer numbers are reserved first. When rows request the same
            unused number, the first included row keeps it. Blank or conflicting numbers
            receive the smallest available positive number in file order. Skipped rows use
            no numbers. Saved customers keep their numbers.
          </p>
          {review.rows.map(row => (
            <details key={row.recordNumber}>
              <summary>
                Record {row.recordNumber}: {row.values.firstName} {row.values.lastName}
              </summary>
              <p>Source customer number: {row.sourceCustomerNumber ?? 'Blank'}</p>
              <p>
                Assigned customer number: {row.assignedCustomerNumber ?? 'Not included'}
              </p>
              <dl>
                {Object.entries(row.values).map(([field, value]) => (
                  <div key={field}>
                    <dt>{field}</dt>
                    <dd>
                      <pre>{String(value)}</pre>
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </>
      )}
    </PageShell>
  );
}
