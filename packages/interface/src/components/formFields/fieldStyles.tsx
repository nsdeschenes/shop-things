import * as stylex from '@stylexjs/stylex';

import {colors} from '../../styles/colors.stylex';
import {controls} from '../../styles/controls.stylex';
import {radii} from '../../styles/radii.stylex';
import {spacing} from '../../styles/spacing.stylex';
import {typography} from '../../styles/typography.stylex';

const styles = stylex.create({
  field: {gap: spacing.space6, display: 'flex', flexDirection: 'column', minWidth: 0},
  label: {fontSize: typography.fontSizeSmall, fontWeight: typography.fontWeightBold},
  error: {color: colors.errorText, fontSize: typography.fontSizeSmall},
  checkbox: {
    gap: spacing.space10,
    alignItems: 'center',
    display: 'flex',
    fontSize: typography.fontSizeSmall,
    fontWeight: typography.fontWeightBold,
  },
  textarea: {
    borderColor: colors.controlBorder,
    borderRadius: radii.control,
    borderStyle: 'solid',
    borderWidth: controls.borderWidth,
    paddingBlock: spacing.space8,
    paddingInline: spacing.space12,
    backgroundColor: colors.surface,
    color: colors.text,
    flexGrow: 1,
    outlineColor: colors.focusRing,
    outlineOffset: controls.focusOffset,
    resize: 'vertical',
    minHeight: 96,
    width: '100%',
  },
});

export default styles;
