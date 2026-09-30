import {Combobox} from '@base-ui/react/combobox';
import {Field} from '@base-ui/react/field';
import * as stylex from '@stylexjs/stylex';

import formContexts from '../../forms/formContexts';
import {colors} from '../../styles/colors.stylex';
import {radii} from '../../styles/radii.stylex';
import {spacing} from '../../styles/spacing.stylex';
import {typography} from '../../styles/typography.stylex';
import inputStyles from '../input/inputStyles';
import fieldStyles from './fieldStyles';

const provinces = ['NS', 'AB', 'BC', 'MB', 'NB', 'NL', 'ON', 'PE', 'QC', 'SK', 'OTHER'];

function provinceLabel(province: string) {
  return province === 'OTHER' ? 'Other' : province;
}

const styles = stylex.create({
  inputGroup: {position: 'relative'},
  input: {paddingRight: 42},
  trigger: {
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.text,
    cursor: 'pointer',
    outlineColor: colors.focusRing,
    position: 'absolute',
    bottom: 0,
    right: 0,
    top: 0,
    width: 42,
  },
  positioner: {zIndex: 10},
  popup: {
    borderColor: colors.controlBorder,
    borderRadius: radii.control,
    borderStyle: 'solid',
    borderWidth: 1,
    paddingBlock: spacing.space4,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: typography.fontSizeBody,
    maxHeight: 'var(--available-height)',
    overflowY: 'auto',
    width: 'var(--anchor-width)',
  },
  item: {
    paddingBlock: spacing.space8,
    paddingInline: spacing.space12,
    backgroundColor: {
      default: 'transparent',
      ':is([data-highlighted])': colors.surfaceHover,
    },
    cursor: 'pointer',
  },
  empty: {
    paddingBlock: spacing.space8,
    paddingInline: spacing.space12,
    color: colors.textMuted,
  },
});

export default function ProvinceField() {
  const field = formContexts.useFieldContext<string>();

  return (
    <Field.Root
      name={field.name}
      dirty={field.state.meta.isDirty}
      touched={field.state.meta.isTouched}
      invalid={!field.state.meta.isValid}
      {...stylex.props(fieldStyles.field)}
    >
      <Field.Label {...stylex.props(fieldStyles.label)}>Province</Field.Label>
      <Combobox.Root
        items={provinces}
        itemToStringLabel={provinceLabel}
        name={field.name}
        value={field.state.value || null}
        onValueChange={value => field.handleChange(value ?? '')}
      >
        <Combobox.InputGroup {...stylex.props(styles.inputGroup)}>
          <Combobox.Input
            onClick={event => event.currentTarget.select()}
            onBlur={field.handleBlur}
            {...stylex.props(inputStyles.input, styles.input)}
          />
          <Combobox.Trigger {...stylex.props(styles.trigger)}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M4 6h8l-4 4z" />
            </svg>
          </Combobox.Trigger>
        </Combobox.InputGroup>
        <Combobox.Portal>
          <Combobox.Positioner sideOffset={4} {...stylex.props(styles.positioner)}>
            <Combobox.Popup {...stylex.props(styles.popup)}>
              <Combobox.Empty>
                <div {...stylex.props(styles.empty)}>No provinces found.</div>
              </Combobox.Empty>
              <Combobox.List>
                {(province: string) => (
                  <Combobox.Item
                    key={province}
                    value={province}
                    {...stylex.props(styles.item)}
                  >
                    {provinceLabel(province)}
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </Field.Root>
  );
}
