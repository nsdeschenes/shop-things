import {ChevronRightIcon} from '@heroicons/react/24/outline';
import type {ImportRow} from '@shop-things/contract';
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
import buttonStyles from '../components/button/buttonStyles';
import {
  CustomerRouteError,
  CustomerRoutePending,
} from '../components/customerRouteFeedback/customerRouteFeedback';
import Input from '../components/input/input';
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
  stats: {
    gap: 12,
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(4, minmax(0, 1fr))',
      '@media (max-width: 650px)': 'repeat(2, minmax(0, 1fr))',
    },
    marginBottom: 12,
  },
  stat: {
    padding: 18,
    borderColor: colors.border,
    borderRadius: radii.large,
    borderStyle: 'solid',
    borderWidth: 1,
    backgroundColor: colors.surface,
  },
  statValue: {
    display: 'block',
    fontSize: 30,
    fontVariantNumeric: 'tabular-nums',
    fontWeight: typography.fontWeightBold,
    lineHeight: 1.15,
    marginBottom: 6,
  },
  statLabel: {color: colors.textMuted, fontSize: typography.fontSizeSmall},
  positive: {backgroundColor: colors.successBackground, color: colors.successText},
  attention: {borderColor: colors.warningText, color: colors.warningText},
  reviewRow: {borderLeftWidth: 4},
  reviewSummary: {
    backgroundColor: {default: '#fff8e6', ':hover': '#fff1cc'},
  },
  reviewBadge: {backgroundColor: '#fff1cc', color: colors.warningText},
  numberNotice: {
    padding: 12,
    borderRadius: radii.panel,
    backgroundColor: colors.successBackground,
    color: colors.successText,
    lineHeight: 1.6,
  },
  status: {
    color: colors.textMuted,
    fontSize: typography.fontSizeSmall,
    lineHeight: 1.6,
    marginBottom: 16,
  },
  policy: {
    color: colors.textMuted,
    fontSize: typography.fontSizeSmall,
    lineHeight: 1.6,
    marginBottom: 24,
  },
  policySummary: {
    color: colors.secondaryText,
    cursor: 'pointer',
    fontWeight: typography.fontWeightSemibold,
  },
  sectionHeading: {fontSize: typography.fontSizeLarge, marginBottom: 12, marginTop: 24},
  row: {
    borderColor: colors.border,
    borderRadius: radii.large,
    borderStyle: 'solid',
    borderWidth: 1,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    marginBottom: 8,
  },
  summary: {
    padding: 16,
    gap: 10,
    alignItems: 'center',
    backgroundColor: {default: colors.surface, ':hover': colors.rowHover},
    cursor: 'pointer',
    display: 'flex',
    listStyleType: 'none',
    outlineColor: colors.focusRing,
  },
  summaryContent: {
    gap: 12,
    alignItems: 'center',
    display: 'flex',
    flexGrow: 1,
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    minWidth: 0,
  },
  chevron: {flexShrink: 0, height: 16, width: 16},
  chevronOpen: {transform: 'rotate(90deg)'},
  name: {fontWeight: typography.fontWeightSemibold},
  rowMeta: {gap: 12, alignItems: 'center', display: 'flex', flexWrap: 'wrap'},
  number: {
    color: colors.textMuted,
    fontSize: typography.fontSizeSmall,
    fontVariantNumeric: 'tabular-nums',
  },
  badge: {
    borderRadius: radii.button,
    paddingBlock: 4,
    paddingInline: 8,
    backgroundColor: colors.disabledBackground,
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: typography.fontWeightSemibold,
  },
  body: {
    padding: 20,
    fontSize: typography.fontSizeSmall,
    borderTopColor: colors.border,
    borderTopStyle: 'solid',
    borderTopWidth: 1,
  },
  matches: {
    padding: 16,
    borderColor: colors.border,
    borderRadius: radii.panel,
    borderStyle: 'solid',
    borderWidth: 1,
    marginBlock: 16,
    lineHeight: 1.6,
  },
  matchList: {padding: 0, gap: 12, display: 'grid', listStyleType: 'none'},
  match: {
    padding: 16,
    borderRadius: radii.panel,
    backgroundColor: colors.pageBackground,
  },
  matchTitle: {fontWeight: typography.fontWeightSemibold, marginBottom: 4},
  matchHelp: {color: colors.textMuted, marginBottom: 12, marginTop: 4},
  matchTargets: {gap: 8, display: 'grid', paddingLeft: 20},
  matchValue: {color: colors.textMuted, display: 'block', overflowWrap: 'anywhere'},
  decisionHelp: {color: colors.textMuted, marginBottom: 16, marginTop: 16},
  editForm: {
    gap: 12,
    alignItems: 'end',
    display: 'flex',
    flexWrap: 'wrap',
    marginTop: 16,
  },
  editLabel: {
    gap: 6,
    display: 'grid',
    flexGrow: 1,
    fontWeight: typography.fontWeightSemibold,
  },
  choice: {
    fontSize: typography.fontSizeSmall,
    minHeight: 30,
    paddingBlock: 4,
    paddingInline: 10,
    marginRight: 8,
  },
  fields: {
    gap: 16,
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(3, minmax(0, 1fr))',
      '@media (max-width: 650px)': 'repeat(2, minmax(0, 1fr))',
    },
    marginBottom: 0,
    marginTop: 20,
  },
  fieldName: {color: colors.textMuted, fontSize: 12, marginBottom: 4},
  field: {padding: 8, borderRadius: radii.panel},
  editedField: {backgroundColor: colors.successBackground},
  detailsHeading: {fontSize: typography.fontSizeBody, marginBottom: 8, marginTop: 20},
  fieldValue: {margin: 0},
  fieldText: {
    margin: 0,
    fontFamily: typography.fontFamily,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  errors: {
    padding: 20,
    borderColor: colors.errorText,
    borderRadius: radii.large,
    borderStyle: 'solid',
    borderWidth: 1,
    backgroundColor: colors.surface,
    color: colors.errorText,
    fontSize: typography.fontSizeSmall,
    lineHeight: 1.6,
    marginBottom: 20,
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
  const collisionCount = review.rows.filter(
    row => row.choice === 'unresolved' && row.matches.length > 0
  ).length;
  const confirmationCount = review.unresolvedCount - collisionCount;
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
                label: 'Pending decisions',
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
            add. {review.skippedCount} skipped. {collisionCount} unresolved possible
            matches. {confirmationCount} awaiting confirmation. {review.numberChangeCount}{' '}
            customer numbers will change. No customers have been added.
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
          {orderedRows.map(row => (
            <details
              key={row.recordNumber}
              {...stylex.props(
                styles.row,
                row.choice === 'unresolved' && [styles.attention, styles.reviewRow]
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
              <summary
                {...stylex.props(
                  styles.summary,
                  row.choice === 'unresolved' && styles.reviewSummary
                )}
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  strokeWidth={2.5}
                  {...stylex.props(
                    styles.chevron,
                    openRecords.has(row.recordNumber) && styles.chevronOpen
                  )}
                />
                <span {...stylex.props(styles.summaryContent)}>
                  <span {...stylex.props(styles.name)}>
                    Record {row.recordNumber}: {row.values.firstName}{' '}
                    {row.values.lastName}
                  </span>
                  <span {...stylex.props(styles.rowMeta)}>
                    <span {...stylex.props(styles.number)}>
                      {row.proposedCustomerNumber !== undefined ? (
                        <>
                          If added: customer #{row.proposedCustomerNumber}
                          {row.proposedCustomerNumber === row.sourceCustomerNumber
                            ? ' (same as CSV)'
                            : ' (new number)'}
                        </>
                      ) : (
                        <>
                          Source to assigned number: {row.sourceCustomerNumber ?? 'Blank'}{' '}
                          → {row.assignedCustomerNumber ?? 'Not included'}
                        </>
                      )}
                    </span>
                    {row.choice === 'unresolved' && !row.matches.length && (
                      <span {...stylex.props(styles.badge, styles.positive)}>
                        No collision
                      </span>
                    )}
                    <span
                      {...stylex.props(
                        styles.badge,
                        row.choice === 'unresolved' && styles.reviewBadge,
                        (row.choice === 'include' || row.choice === 'add') &&
                          styles.positive
                      )}
                    >
                      {row.choice === 'unresolved'
                        ? row.matches.length > 0
                          ? 'Needs review'
                          : 'Awaiting confirmation'
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
                  {row.proposedCustomerNumber !== undefined ? (
                    <div {...stylex.props(styles.numberNotice)}>
                      <strong>
                        If added, customer number {row.proposedCustomerNumber}
                        {row.proposedCustomerNumber === row.sourceCustomerNumber
                          ? ' will be kept from the CSV.'
                          : row.sourceCustomerNumber === null
                            ? ' will be assigned.'
                            : ' will replace the CSV number.'}
                      </strong>
                      <div>
                        This plan assumes the pending records are added. Numbers update if
                        records are skipped.
                      </div>
                    </div>
                  ) : (
                    <p>
                      <span>
                        Assigned customer number:{' '}
                        {row.assignedCustomerNumber ?? 'Not included'}
                      </span>
                      {row.assignedCustomerNumber !== null &&
                        row.assignedCustomerNumber === row.sourceCustomerNumber && (
                          <span> — same as CSV; this number will be kept.</span>
                        )}
                    </p>
                  )}
                  {row.matches.length > 0 ||
                  row.collisionFields?.length ||
                  row.choice !== 'include' ? (
                    <fieldset disabled={disabled} {...stylex.props(styles.matches)}>
                      <legend>
                        {row.matches.length > 0 ? 'Possible matches' : 'Confirm customer'}{' '}
                        for record {row.recordNumber}
                      </legend>
                      <p>
                        {row.matches.length > 0
                          ? 'This record may be a duplicate. It shares the details below with another CSV record or a saved customer. Check the matches before deciding whether to add it.'
                          : row.editedFields?.length
                            ? 'No email or phone collision remains. Review the updated customer details below, then confirm that this is the correct record to import.'
                            : 'No email or phone collision remains. The matching record was edited. Confirm whether to add this customer or skip it.'}
                      </p>
                      <ul {...stylex.props(styles.matchList)}>
                        {row.matches.map(id => {
                          const group = review.matchGroups.find(item => item.id === id)!;
                          const incomingValue =
                            group.reason === 'name'
                              ? `${row.values.firstName} ${row.values.lastName}`.trim()
                              : row.values[group.reason];
                          return (
                            <li key={id} {...stylex.props(styles.match)}>
                              <div {...stylex.props(styles.matchTitle)}>
                                Matching {group.reason}:
                              </div>
                              <div>
                                Your CSV value:{' '}
                                <strong>{incomingValue || 'Not provided'}</strong>
                              </div>
                              <p {...stylex.props(styles.matchHelp)}>
                                {group.reason === 'phone'
                                  ? 'The phone digits match; spaces, brackets, and punctuation are ignored.'
                                  : group.reason === 'email'
                                    ? 'The email addresses match; capitalization and surrounding spaces are ignored.'
                                    : 'The first and last names match; capitalization and surrounding spaces are ignored.'}
                              </p>
                              <ul {...stylex.props(styles.matchTargets)}>
                                {group.targets
                                  .filter(
                                    target =>
                                      target.kind !== 'csv' ||
                                      target.recordNumber !== row.recordNumber
                                  )
                                  .map(target => {
                                    const otherRow =
                                      target.kind === 'csv'
                                        ? recordsByNumber.get(target.recordNumber)
                                        : undefined;
                                    const otherValue = otherRow
                                      ? group.reason === 'name'
                                        ? `${otherRow.values.firstName} ${otherRow.values.lastName}`.trim()
                                        : otherRow.values[group.reason]
                                      : null;
                                    return (
                                      <li
                                        key={
                                          target.kind === 'csv'
                                            ? `csv:${target.recordNumber}`
                                            : `customer:${target.id}`
                                        }
                                      >
                                        {target.kind === 'csv' ? (
                                          <>
                                            <span>CSV record {target.recordNumber}</span>
                                            {otherRow && (
                                              <span>
                                                : {otherRow.values.firstName}{' '}
                                                {otherRow.values.lastName}
                                              </span>
                                            )}
                                            {otherValue && (
                                              <span {...stylex.props(styles.matchValue)}>
                                                {otherValue}
                                              </span>
                                            )}
                                          </>
                                        ) : (
                                          <>
                                            <span>
                                              Saved customer{' '}
                                              {target.customerNumber ?? '(no number)'}:{' '}
                                              {target.firstName} {target.lastName}
                                            </span>
                                            <span {...stylex.props(styles.matchValue)}>
                                              Already in your database with a matching{' '}
                                              {group.reason}.
                                            </span>
                                          </>
                                        )}
                                      </li>
                                    );
                                  })}
                              </ul>
                            </li>
                          );
                        })}
                      </ul>
                      {Array.from(
                        new Set([
                          ...(row.collisionFields ?? []),
                          ...(row.editedFields ?? []),
                          ...row.matches.flatMap(id => {
                            const reason = groups.get(id)?.reason;
                            return reason === 'email' || reason === 'phone'
                              ? [reason]
                              : [];
                          }),
                        ]),
                        field => (
                          <div key={field} {...stylex.props(styles.match)}>
                            <form
                              key={row.values[field]}
                              {...stylex.props(styles.editForm)}
                              onSubmit={event => {
                                event.preventDefault();
                                const value = new FormData(event.currentTarget).get(
                                  'value'
                                );
                                if (typeof value === 'string') {
                                  void resolve(row.recordNumber, {field, value});
                                }
                              }}
                            >
                              <label {...stylex.props(styles.editLabel)}>
                                New {field}
                                <Input
                                  aria-label={`New ${field} for record ${row.recordNumber}`}
                                  name="value"
                                  defaultValue={row.values[field]}
                                  disabled={disabled}
                                />
                              </label>
                              <Button type="submit" disabled={disabled}>
                                Apply change
                              </Button>
                            </form>
                            <p {...stylex.props(styles.matchHelp)}>
                              Change this imported customer's {field} and check the
                              matches again. Leave it blank to clear it. Review and
                              confirm the updated record before importing.
                            </p>
                          </div>
                        )
                      )}
                      {(row.editedFields?.length || row.matches.length === 0) && (
                        <ImportCustomerDetails row={row} />
                      )}
                      <p {...stylex.props(styles.decisionHelp)}>
                        <strong>
                          {row.matches.length > 0
                            ? 'Add anyway'
                            : row.editedFields?.length
                              ? 'Confirm and add'
                              : 'Add customer'}
                        </strong>{' '}
                        {row.matches.length > 0
                          ? 'includes this record in the import.'
                          : 'imports this record using the customer number shown above.'}{' '}
                        <strong>Skip</strong> leaves this record out of the import.
                      </p>
                      <button
                        type="button"
                        aria-pressed={row.choice === 'add'}
                        disabled={disabled}
                        {...stylex.props(
                          buttonStyles.base,
                          buttonStyles.primary,
                          styles.choice
                        )}
                        onClick={() => {
                          void resolve(row.recordNumber, 'add');
                        }}
                      >
                        {row.matches.length > 0
                          ? 'Add anyway'
                          : row.editedFields?.length
                            ? 'Confirm and add'
                            : 'Add customer'}
                      </button>
                      <button
                        type="button"
                        aria-pressed={row.choice === 'skip'}
                        disabled={disabled}
                        {...stylex.props(
                          buttonStyles.base,
                          row.choice === 'skip' && buttonStyles.primary,
                          styles.choice
                        )}
                        onClick={() => {
                          void resolve(row.recordNumber, 'skip');
                        }}
                      >
                        Skip
                      </button>
                    </fieldset>
                  ) : (
                    <p>Included automatically</p>
                  )}
                  {(row.choice === 'include' ||
                    (row.matches.length > 0 && !row.editedFields?.length)) && (
                    <ImportCustomerDetails row={row} />
                  )}
                </div>
              )}
            </details>
          ))}
        </>
      )}
    </PageShell>
  );
}

function ImportCustomerDetails({row}: {row: ImportRow}) {
  const title = row.editedFields?.length
    ? 'Updated customer details'
    : 'Customer details';
  return (
    <section aria-label={`${title} for record ${row.recordNumber}`}>
      <h3 {...stylex.props(styles.detailsHeading)}>{title}</h3>
      <dl {...stylex.props(styles.fields)}>
        {Object.entries(row.values).map(([field, value]) => (
          <div
            key={field}
            {...stylex.props(
              styles.field,
              row.editedFields?.some(edited => edited === field) && styles.editedField
            )}
          >
            <dt {...stylex.props(styles.fieldName)}>
              {field}
              {row.editedFields?.some(edited => edited === field) && ' · Updated'}
            </dt>
            <dd {...stylex.props(styles.fieldValue)}>
              <pre {...stylex.props(styles.fieldText)}>{String(value) || '—'}</pre>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
