import type {ImportReview} from '@shop-things/contract';
import * as stylex from '@stylexjs/stylex';

import {colors} from '../../styles/colors.stylex';
import {radii} from '../../styles/radii.stylex';
import {typography} from '../../styles/typography.stylex';

const styles = stylex.create({
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

type Props = {
  review: Pick<
    ImportReview,
    'invalidRecordCount' | 'diagnostics' | 'omittedDiagnosticCount'
  >;
};

export default function CustomerImportDiagnostics({review}: Props) {
  return (
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
          {review.omittedDiagnosticCount} additional details omitted. Showing the first
          100 errors.
        </p>
      )}
    </section>
  );
}
