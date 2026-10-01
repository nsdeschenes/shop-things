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
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 16,
    padding: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radii.large,
    marginBottom: 20,
  },
  fileName: {
    margin: 0,
    fontWeight: typography.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  fileHint: {
    marginTop: 6,
    marginBottom: 0,
    color: colors.textMuted,
    fontSize: typography.fontSizeSmall,
  },
  actions: {display: 'flex', flexWrap: 'wrap', gap: 8},
  stats: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(4, minmax(0, 1fr))',
      '@media (max-width: 650px)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: 12,
    marginBottom: 12,
  },
  stat: {
    padding: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radii.large,
  },
  statValue: {
    display: 'block',
    fontSize: 30,
    fontWeight: typography.fontWeightBold,
    lineHeight: 1.15,
    fontVariantNumeric: 'tabular-nums',
    marginBottom: 6,
  },
  statLabel: {color: colors.textMuted, fontSize: typography.fontSizeSmall},
  positive: {backgroundColor: colors.successBackground, color: colors.successText},
  attention: {borderColor: colors.warningText, color: colors.warningText},
  status: {
    fontSize: typography.fontSizeSmall,
    lineHeight: 1.6,
    color: colors.textMuted,
    marginBottom: 16,
  },
  policy: {
    fontSize: typography.fontSizeSmall,
    lineHeight: 1.6,
    color: colors.textMuted,
    marginBottom: 24,
  },
  policySummary: {
    cursor: 'pointer',
    color: colors.secondaryText,
    fontWeight: typography.fontWeightSemibold,
  },
  sectionHeading: {fontSize: typography.fontSizeLarge, marginTop: 24, marginBottom: 12},
  row: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radii.large,
    marginBottom: 8,
    overflow: 'hidden',
  },
  summary: {
    padding: 16,
    cursor: 'pointer',
    backgroundColor: {default: colors.surface, ':hover': colors.rowHover},
    outlineColor: colors.focusRing,
  },
  summaryContent: {
    display: 'inline-flex',
    width: 'calc(100% - 24px)',
    verticalAlign: 'middle',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
  },
  name: {fontWeight: typography.fontWeightSemibold},
  rowMeta: {display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12},
  number: {
    fontSize: typography.fontSizeSmall,
    color: colors.textMuted,
    fontVariantNumeric: 'tabular-nums',
  },
  badge: {
    fontSize: 12,
    fontWeight: typography.fontWeightSemibold,
    paddingBlock: 4,
    paddingInline: 8,
    borderRadius: radii.button,
    backgroundColor: colors.disabledBackground,
    color: colors.textMuted,
  },
  body: {
    padding: 20,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
    fontSize: typography.fontSizeSmall,
  },
  matches: {
    padding: 16,
    marginBlock: 16,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radii.panel,
    lineHeight: 1.6,
  },
  choice: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    marginRight: 20,
    fontWeight: typography.fontWeightSemibold,
    cursor: 'pointer',
  },
  fields: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(3, minmax(0, 1fr))',
      '@media (max-width: 650px)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: 16,
    marginTop: 20,
    marginBottom: 0,
  },
  fieldName: {color: colors.textMuted, fontSize: 12, marginBottom: 4},
  fieldValue: {margin: 0},
  fieldText: {
    margin: 0,
    fontFamily: typography.fontFamily,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  errors: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.errorText,
    borderRadius: radii.large,
    padding: 20,
    color: colors.errorText,
    marginBottom: 20,
    fontSize: typography.fontSizeSmall,
    lineHeight: 1.6,
  },
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
  const [openRecords, setOpenRecords] = useState<ReadonlySet<number>>(new Set());
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

  async function resolve(recordNumber: number, choice: 'add' | 'skip') {
    const captured = application.captureSession(review.session);
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
      {review.status === 'rejected' && (
        <section role="alert" {...stylex.props(styles.errors)}>
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
      {review.status === 'ready' && !committed && (
        <>
          <div {...stylex.props(styles.stats)}>
            {[
              {label: 'Source records', count: review.sourceRecordCount},
              {label: 'Customers to add', count: review.includedCount, positive: true},
              {
                label: 'Need review',
                count: review.unresolvedCount,
                attention: review.unresolvedCount > 0,
              },
              {label: 'Skipped', count: review.skippedCount},
            ].map(stat => (
              <div
                key={stat.label}
                {...stylex.props(
                  styles.stat,
                  stat.positive && styles.positive,
                  stat.attention && styles.attention
                )}
              >
                <strong {...stylex.props(styles.statValue)}>{stat.count}</strong>
                <span {...stylex.props(styles.statLabel)}>{stat.label}</span>
              </div>
            ))}
          </div>
          <p role="status" {...stylex.props(styles.status)}>
            {review.sourceRecordCount} source records. {review.includedCount} customers to
            add. {review.skippedCount} skipped. {review.unresolvedCount} unresolved
            possible matches. {review.numberChangeCount} customer numbers will change. No
            customers have been added.
          </p>
          <details {...stylex.props(styles.policy)}>
            <summary {...stylex.props(styles.policySummary)}>
              How customer numbers are assigned
            </summary>
            <p>
              Unused source customer numbers are reserved first. When rows request the
              same unused number, the first included row keeps it. Blank or conflicting
              numbers receive the smallest available positive number in file order.
              Skipped rows use no numbers. Saved customers keep their numbers.
            </p>
          </details>
          <h2 {...stylex.props(styles.sectionHeading)}>Customer review</h2>
          {review.rows.map(row => (
            <details
              key={row.recordNumber}
              {...stylex.props(
                styles.row,
                row.choice === 'unresolved' && styles.attention
              )}
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
              <summary {...stylex.props(styles.summary)}>
                <span {...stylex.props(styles.summaryContent)}>
                  <span {...stylex.props(styles.name)}>
                    Record {row.recordNumber}: {row.values.firstName}{' '}
                    {row.values.lastName}
                  </span>
                  <span {...stylex.props(styles.rowMeta)}>
                    <span {...stylex.props(styles.number)}>
                      Source to assigned number: {row.sourceCustomerNumber ?? 'Blank'} →{' '}
                      {row.assignedCustomerNumber ?? 'Not included'}
                    </span>
                    <span
                      {...stylex.props(
                        styles.badge,
                        row.choice === 'unresolved' && styles.attention,
                        (row.choice === 'include' || row.choice === 'add') &&
                          styles.positive
                      )}
                    >
                      {row.choice === 'unresolved'
                        ? 'Needs review'
                        : row.choice === 'skip'
                          ? 'Skipped'
                          : 'Ready to add'}
                    </span>
                  </span>
                </span>
              </summary>
              {openRecords.has(row.recordNumber) && (
                <div {...stylex.props(styles.body)}>
                  <p>Source customer number: {row.sourceCustomerNumber ?? 'Blank'}</p>
                  <p>
                    Assigned customer number:{' '}
                    {row.assignedCustomerNumber ?? 'Not included'}
                  </p>
                  {row.matches.length > 0 ? (
                    <fieldset disabled={disabled} {...stylex.props(styles.matches)}>
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
                      <label {...stylex.props(styles.choice)}>
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
                      <label {...stylex.props(styles.choice)}>
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
                  <dl {...stylex.props(styles.fields)}>
                    {Object.entries(row.values).map(([field, value]) => (
                      <div key={field}>
                        <dt {...stylex.props(styles.fieldName)}>{field}</dt>
                        <dd {...stylex.props(styles.fieldValue)}>
                          <pre {...stylex.props(styles.fieldText)}>
                            {String(value) || '—'}
                          </pre>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </details>
          ))}
        </>
      )}
    </PageShell>
  );
}
