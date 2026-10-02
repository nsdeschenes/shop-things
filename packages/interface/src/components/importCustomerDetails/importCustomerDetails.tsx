import type {ImportRow} from '@shop-things/contract';
import * as stylex from '@stylexjs/stylex';

import {colors} from '../../styles/colors.stylex';
import {radii} from '../../styles/radii.stylex';
import {typography} from '../../styles/typography.stylex';

const styles = stylex.create({
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
});

export default function ImportCustomerDetails({row}: {row: ImportRow}) {
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
