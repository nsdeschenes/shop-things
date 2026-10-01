/* oxlint-disable @tanstack/query/exhaustive-deps -- Navigation scope controls admission, not review identity. */
import {queryOptions, useQuery} from '@tanstack/react-query';
import {createFileRoute, redirect} from '@tanstack/react-router';
import {useState, useSyncExternalStore} from 'react';
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
  const loaded = Route.useLoaderData();
  const {application, queryClient} = Route.useRouteContext();
  const {data: review} = useQuery(
    queryOptions({
      queryKey: ['imports', loaded.session, loaded.importId],
      queryFn: async () => {
        const result = await application.read(loaded.session, client =>
          client.imports.review({session: loaded.session, importId: loaded.importId})
        );
        if (result.status === 'error') {
          throw new CustomerRequestError(result.error);
        }

        if (result.status !== 'success') {
          throw new Error('Could not load the import. Try again.');
        }

        return result.value;
      },
      initialData: loaded,
      staleTime: Infinity,
    })
  );
  const [openRecords, setOpenRecords] = useState<ReadonlySet<number>>(new Set());
  const [updating, setUpdating] = useState(false);
  async function resolve(recordNumber: number, choice: 'add' | 'skip') {
    setUpdating(true);
    try {
      const result = await application.request(review.session, client =>
        client.imports.resolve({
          session: review.session,
          importId: review.importId,
          recordNumber,
          choice,
        })
      );
      if (result.status === 'success') {
        queryClient.setQueryData(
          ['imports', review.session, review.importId],
          result.value
        );
      } else if (result.status === 'error') {
        application.toasts.error({title: result.error.message});
      }
    } finally {
      setUpdating(false);
    }
  }

  const state = useSyncExternalStore(application.subscribe, application.getState);
  const navigate = Route.useNavigate();
  const expired =
    state.database?.available === true && state.database.session !== review.session;
  const disabled =
    updating ||
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
            {review.sourceRecordCount} source records. {review.includedCount} customers to
            add. {review.skippedCount} skipped. {review.unresolvedCount} unresolved
            possible matches. No customers have been added.
          </p>
          {review.rows.map(row => (
            <details
              key={row.recordNumber}
              onToggle={event => {
                const open = event.currentTarget.open;
                setOpenRecords(previous => {
                  const next = new Set(previous);
                  if (open) {
                    next.add(row.recordNumber);
                  } else {
                    next.delete(row.recordNumber);
                  }

                  return next;
                });
              }}
            >
              <summary>
                Record {row.recordNumber}: {row.values.firstName} {row.values.lastName}
              </summary>
              {openRecords.has(row.recordNumber) && (
                <>
                  <p>Source customer number: {row.sourceCustomerNumber ?? 'Blank'}</p>
                  {row.matches.length > 0 ? (
                    <fieldset disabled={disabled}>
                      <legend>Possible matches for record {row.recordNumber}</legend>
                      <p>
                        Matching details are signals. Add anyway creates a separate
                        customer.
                      </p>
                      <ul>
                        {row.matches.map(id => {
                          const group = review.matchGroups.find(item => item.id === id)!;
                          return (
                            <li key={id}>
                              Matching {group.reason}:
                              <ul>
                                {group.targets
                                  .filter(
                                    target =>
                                      target.kind !== 'csv' ||
                                      target.recordNumber !== row.recordNumber
                                  )
                                  .map(target => (
                                    <li
                                      key={
                                        target.kind === 'csv'
                                          ? `csv:${target.recordNumber}`
                                          : `customer:${target.id}`
                                      }
                                    >
                                      {target.kind === 'csv'
                                        ? `CSV record ${target.recordNumber}`
                                        : `Saved customer ${target.customerNumber ?? '(no number)'}: ${target.firstName} ${target.lastName} (ID ${target.id})`}
                                    </li>
                                  ))}
                              </ul>
                            </li>
                          );
                        })}
                      </ul>
                      <label>
                        <input
                          type="radio"
                          name={`choice-${row.recordNumber}`}
                          checked={row.choice === 'add'}
                          onChange={() => {
                            void resolve(row.recordNumber, 'add');
                          }}
                        />
                        Add anyway
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`choice-${row.recordNumber}`}
                          checked={row.choice === 'skip'}
                          onChange={() => {
                            void resolve(row.recordNumber, 'skip');
                          }}
                        />
                        Skip
                      </label>
                    </fieldset>
                  ) : (
                    <p>Included automatically</p>
                  )}
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
                </>
              )}
            </details>
          ))}
        </>
      )}
    </PageShell>
  );
}
