/* oxlint-disable @tanstack/query/exhaustive-deps -- Navigation scope controls admission, not review identity. */
import * as stylex from '@stylexjs/stylex';
import {queryOptions, useQuery} from '@tanstack/react-query';
import {createFileRoute, redirect} from '@tanstack/react-router';
import {useRef, useState, useSyncExternalStore} from 'react';
import {z} from 'zod';

import type {Application, RequestScope} from '../application/controller';
import {CustomerRequestError, refreshSavedCustomers} from '../application/customers';
import {admitCustomerRoute} from '../application/routing';
import Button from '../components/button/button';
import CustomerImportDiagnostics from '../components/customerImportDiagnostics/customerImportDiagnostics';
import CustomerImportRecord from '../components/customerImportRecord/customerImportRecord';
import CustomerImportSummary from '../components/customerImportSummary/customerImportSummary';
import {
  CustomerRouteError,
  CustomerRoutePending,
} from '../components/customerRouteFeedback/customerRouteFeedback';
import PageShell from '../components/pageShell/pageShell';
import {colors} from '../styles/colors.stylex';
import {radii} from '../styles/radii.stylex';
import {typography} from '../styles/typography.stylex';

const styles = stylex.create({
  fileBar: {
    padding: 20,
    borderColor: colors.border,
    borderRadius: radii.large,
    borderStyle: 'solid',
    borderWidth: 1,
    gap: 16,
    alignItems: 'center',
    backgroundColor: colors.surface,
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  fileName: {
    margin: 0,
    fontWeight: typography.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  fileHint: {
    color: colors.textMuted,
    fontSize: typography.fontSizeSmall,
    marginBottom: 0,
    marginTop: 6,
  },
  actions: {gap: 8, display: 'flex', flexWrap: 'wrap'},
  sectionHeading: {fontSize: typography.fontSizeLarge, marginBottom: 12, marginTop: 24},
});

function importReviewOptions(
  application: Application,
  session: string,
  importId: string,
  readScope?: RequestScope
) {
  return queryOptions({
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
}

export const Route = createFileRoute('/customers_/import')({
  validateSearch: z.object({importId: z.string().optional()}),
  loaderDeps: ({search}) => ({importId: search.importId}),
  beforeLoad: admitCustomerRoute,
  loader: async ({context: {application, queryClient, session, readScope}, deps}) => {
    if (!deps.importId || !session) {
      throw redirect({to: '/customers'});
    }

    return queryClient.fetchQuery(
      importReviewOptions(application, session, deps.importId, readScope)
    );
  },
  pendingComponent: CustomerRoutePending,
  errorComponent: CustomerRouteError,
  component: ImportReview,
});

function ImportReview() {
  const loaded = Route.useLoaderData();
  const {application, queryClient} = Route.useRouteContext();
  const {data: review} = useQuery({
    ...importReviewOptions(application, loaded.session, loaded.importId),
    initialData: loaded,
  });
  const [updating, setUpdating] = useState(false);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const refreshingRequest = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [committed, setCommitted] = useState<{
    session: string;
    addedCount: number;
    skippedCount: number;
  } | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  async function refresh(session: string, addedCount: number, skippedCount: number) {
    if (refreshingRequest.current) {
      return;
    }

    refreshingRequest.current = true;
    setRefreshing(true);
    setRefreshError(true);
    const captured = application.captureSession(session);
    try {
      if (!captured.isCurrent()) {
        return;
      }

      if (!(await refreshSavedCustomers(application, session)) || !captured.isCurrent()) {
        return;
      }

      await navigate({to: '/customers'});
      if (captured.isCurrent()) {
        setRefreshError(false);
        application.toasts.success({
          title: `${addedCount} customers added. ${skippedCount} skipped.`,
        });
      }
    } catch {
      if (captured.isCurrent()) {
        setRefreshError(true);
      }
    } finally {
      refreshingRequest.current = false;
      setRefreshing(false);
    }
  }

  async function commit() {
    if (submitting.current || committed) {
      return;
    }

    const captured = application.captureSession(review.session);
    submitting.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await application.commitImport(review.session, review.importId);
      if (!captured.isCurrent()) {
        return;
      }

      if (result.status === 'success') {
        if (result.value.kind === 'changed') {
          queryClient.setQueryData(
            ['imports', review.session, review.importId],
            result.value.review
          );
          setFeedback(
            'Saved customers changed. Review the updated plan before adding customers.'
          );
        } else {
          const actual = result.value;
          setCommitted(actual);
          setSaving(false);
          await refresh(actual.session, actual.addedCount, actual.skippedCount);
        }
      } else if (result.status === 'error') {
        setFeedback(result.error.message);
      } else if (result.status === 'cancelled') {
        setFeedback('Backup cancelled. No customers were added.');
      }
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  async function resolve(
    recordNumber: number,
    change: 'add' | 'skip' | {field: 'email' | 'phone'; value: string}
  ) {
    if (disabled) {
      return;
    }

    const captured = application.captureSession(review.session);
    setUpdating(true);
    try {
      const result = await application.request(review.session, client =>
        client.imports.resolve({
          session: review.session,
          importId: review.importId,
          recordNumber,
          ...(typeof change === 'string' ? {choice: change} : change),
        })
      );
      if (!captured.isCurrent()) {
        return;
      }

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
    saving ||
    refreshing ||
    Boolean(committed) ||
    Boolean(state.pendingFile) ||
    state.pendingTransition ||
    state.reconciling ||
    !state.database?.available ||
    expired;
  const orderedRows = review.rows.toSorted(
    (a, b) => Number(b.choice === 'unresolved') - Number(a.choice === 'unresolved')
  );
  const groups = new Map(review.matchGroups.map(group => [group.id, group]));
  const recordsByNumber = new Map(review.rows.map(row => [row.recordNumber, row]));
  return (
    <PageShell
      title="Import Customers"
      actions={
        <Button
          disabled={saving || refreshing || Boolean(state.pendingFile)}
          onClick={() => {
            void navigate({to: '/customers'});
          }}
        >
          Cancel
        </Button>
      }
    >
      <section {...stylex.props(styles.fileBar)} aria-label="Selected CSV file">
        <div>
          <p {...stylex.props(styles.fileName)}>Selected file: {review.fileName}</p>
          <p {...stylex.props(styles.fileHint)}>
            Review your customers before adding them.
          </p>
        </div>
        <div {...stylex.props(styles.actions)}>
          <Button
            disabled={disabled}
            onClick={() => {
              void application.prepareImport().then(result => {
                if (result.status === 'success') {
                  void navigate({
                    search: {importId: result.value.importId},
                    replace: true,
                  });
                } else if (result.status === 'error') {
                  application.toasts.error({title: result.error.message});
                }
              });
            }}
          >
            Choose another file
          </Button>
          {review.status === 'ready' && !committed && (
            <Button
              variant="primary"
              disabled={disabled || !review.choicesResolved || review.includedCount === 0}
              onClick={() => {
                void commit();
              }}
            >
              Add {review.includedCount} customers
            </Button>
          )}
        </div>
      </section>
      {feedback && <p role="alert">{feedback}</p>}
      {saving && <p role="status">Backing up and adding customers...</p>}
      {refreshing && <p role="status">Refreshing saved customers...</p>}
      {committed && (
        <p role="status">
          {committed.addedCount} customers added. {committed.skippedCount} skipped.
        </p>
      )}
      {refreshError && !refreshing && (
        <>
          <p role="alert">
            Customers were added, but the customer list could not be refreshed.
          </p>
          <Button
            disabled={
              refreshing ||
              !state.database?.available ||
              expired ||
              Boolean(state.pendingFile) ||
              state.pendingTransition ||
              state.reconciling
            }
            onClick={() => {
              if (committed) {
                void refresh(
                  committed.session,
                  committed.addedCount,
                  committed.skippedCount
                );
              }
            }}
          >
            Retry refresh
          </Button>
        </>
      )}
      {expired ? (
        <p role="alert">This import expired. Choose the file again.</p>
      ) : !state.database?.available ? (
        <p role="alert">The database is unavailable. Your review is retained.</p>
      ) : null}
      {review.status === 'empty' && <p role="status">No customers to import</p>}
      {review.status === 'rejected' && <CustomerImportDiagnostics review={review} />}
      {review.status === 'ready' && !committed && (
        <>
          <CustomerImportSummary review={review} />
          <h2 {...stylex.props(styles.sectionHeading)}>Customer review</h2>
          {orderedRows.map(row => (
            <CustomerImportRecord
              key={row.recordNumber}
              row={row}
              groups={groups}
              recordsByNumber={recordsByNumber}
              disabled={disabled}
              onResolve={resolve}
            />
          ))}
        </>
      )}
    </PageShell>
  );
}
