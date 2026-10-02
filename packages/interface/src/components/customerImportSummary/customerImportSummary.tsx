import type {ImportReview} from '@shop-things/contract';
import * as stylex from '@stylexjs/stylex';

import {colors} from '../../styles/colors.stylex';
import {radii} from '../../styles/radii.stylex';
import {typography} from '../../styles/typography.stylex';

const styles = stylex.create({
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
});

export default function CustomerImportSummary({review}: {review: ImportReview}) {
  const collisionCount = review.rows.filter(
    row => row.choice === 'unresolved' && row.matches.length > 0
  ).length;
  const confirmationCount = review.unresolvedCount - collisionCount;
  return (
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
        add. {review.skippedCount} skipped. {collisionCount} unresolved possible matches.{' '}
        {confirmationCount} awaiting confirmation. {review.numberChangeCount} customer
        numbers will change. No customers have been added.
      </p>
      <details {...stylex.props(styles.policy)}>
        <summary {...stylex.props(styles.policySummary)}>
          How customer numbers are assigned
        </summary>
        <p>
          Unused source customer numbers are reserved first. When rows request the same
          unused number, the first included row keeps it. Blank or conflicting numbers
          receive the smallest available positive number in file order. Skipped rows use
          no numbers. Saved customers keep their numbers.
        </p>
      </details>
    </>
  );
}
