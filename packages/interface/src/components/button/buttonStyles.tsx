import * as stylex from '@stylexjs/stylex';

import {colors} from '../../styles/colors.stylex';
import {controls} from '../../styles/controls.stylex';
import {radii} from '../../styles/radii.stylex';
import {spacing} from '../../styles/spacing.stylex';
import {typography} from '../../styles/typography.stylex';

const buttonStyles = stylex.create({
  base: {
    borderColor: colors.controlBorder,
    borderRadius: radii.button,
    borderStyle: 'solid',
    borderWidth: controls.borderWidth,
    gap: spacing.space8,
    paddingBlock: spacing.space6,
    paddingInline: spacing.space12,
    textDecoration: 'none',
    alignItems: 'center',
    backgroundColor: {default: colors.surface, ':hover': colors.surfaceHover},
    color: colors.secondaryText,
    cursor: {default: 'pointer', ':disabled': 'not-allowed'},
    display: 'inline-flex',
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightMedium,
    justifyContent: 'center',
    lineHeight: typography.lineHeightControl,
    outlineColor: colors.focusRing,
    outlineOffset: controls.buttonFocusOffset,
    textAlign: 'center',
    minHeight: 36,
  },
  primary: {
    borderColor: {
      default: colors.primary,
      ':disabled:not([aria-busy="true"])': colors.controlBorder,
    },
    backgroundColor: {
      default: colors.primary,
      ':disabled:not([aria-busy="true"])': colors.disabledBackground,
      ':hover:is(:not(:disabled), [aria-busy="true"])': colors.primaryHover,
    },
    color: {
      default: colors.onPrimary,
      ':disabled:not([aria-busy="true"])': colors.textMuted,
    },
  },
  danger: {
    borderColor: {
      default: colors.danger,
      ':disabled:not([aria-busy="true"])': colors.controlBorder,
    },
    backgroundColor: {
      default: colors.danger,
      ':disabled:not([aria-busy="true"])': colors.disabledBackground,
      ':hover:is(:not(:disabled), [aria-busy="true"])': colors.dangerHover,
    },
    color: {
      default: colors.onPrimary,
      ':disabled:not([aria-busy="true"])': colors.textMuted,
    },
  },
});

export default buttonStyles;
