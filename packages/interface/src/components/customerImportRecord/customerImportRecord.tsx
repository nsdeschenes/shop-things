import {ChevronRightIcon} from '@heroicons/react/24/outline';
import type {ImportReview, ImportRow} from '@shop-things/contract';
import * as stylex from '@stylexjs/stylex';
import {useState} from 'react';

import {colors} from '../../styles/colors.stylex';
import {radii} from '../../styles/radii.stylex';
import {typography} from '../../styles/typography.stylex';
import Button from '../button/button';
import buttonStyles from '../button/buttonStyles';
import ImportCustomerDetails from '../importCustomerDetails/importCustomerDetails';
import Input from '../input/input';

const styles = stylex.create({
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
    paddingBlock: 4,
    paddingInline: 10,
    fontSize: typography.fontSizeSmall,
    marginRight: 8,
    minHeight: 30,
  },
});

type Props = {
  row: ImportRow;
  groups: ReadonlyMap<string, ImportReview['matchGroups'][number]>;
  recordsByNumber: ReadonlyMap<number, ImportRow>;
  disabled: boolean;
  onResolve: (
    recordNumber: number,
    change: 'add' | 'skip' | {field: 'email' | 'phone'; value: string}
  ) => void | Promise<void>;
};

export default function CustomerImportRecord({
  row,
  groups,
  recordsByNumber,
  disabled,
  onResolve,
}: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details
      {...stylex.props(
        styles.row,
        row.choice === 'unresolved' && [styles.attention, styles.reviewRow]
      )}
      onToggle={event => {
        setOpen(event.currentTarget.open);
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
          {...stylex.props(styles.chevron, open && styles.chevronOpen)}
        />
        <span {...stylex.props(styles.summaryContent)}>
          <span {...stylex.props(styles.name)}>
            Record {row.recordNumber}: {row.values.firstName} {row.values.lastName}
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
                  Source to assigned number: {row.sourceCustomerNumber ?? 'Blank'} →{' '}
                  {row.assignedCustomerNumber ?? 'Not included'}
                </>
              )}
            </span>
            {row.choice === 'unresolved' && !row.matches.length && (
              <span {...stylex.props(styles.badge, styles.positive)}>No collision</span>
            )}
            <span
              {...stylex.props(
                styles.badge,
                row.choice === 'unresolved' && styles.reviewBadge,
                (row.choice === 'include' || row.choice === 'add') && styles.positive
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
      {open && (
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
                This plan assumes the pending records are added. Numbers update if records
                are skipped.
              </div>
            </div>
          ) : (
            <p>
              <span>
                Assigned customer number: {row.assignedCustomerNumber ?? 'Not included'}
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
                {row.matches.length > 0 ? 'Possible matches' : 'Confirm customer'} for
                record {row.recordNumber}
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
                  const group = groups.get(id)!;
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
                        Your CSV value: <strong>{incomingValue || 'Not provided'}</strong>
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
                                      Saved customer {target.customerNumber}:{' '}
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
                    return reason === 'email' || reason === 'phone' ? [reason] : [];
                  }),
                ]),
                field => (
                  <div key={field} {...stylex.props(styles.match)}>
                    <form
                      key={row.values[field]}
                      {...stylex.props(styles.editForm)}
                      onSubmit={event => {
                        event.preventDefault();
                        const value = new FormData(event.currentTarget).get('value');
                        if (typeof value === 'string') {
                          void onResolve(row.recordNumber, {field, value});
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
                      Change this imported customer's {field} and check the matches again.
                      Leave it blank to clear it. Review and confirm the updated record
                      before importing.
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
                {...stylex.props(buttonStyles.base, buttonStyles.primary, styles.choice)}
                onClick={() => {
                  void onResolve(row.recordNumber, 'add');
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
                  void onResolve(row.recordNumber, 'skip');
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
  );
}
