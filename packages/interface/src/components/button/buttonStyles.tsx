import * as stylex from "@stylexjs/stylex";
import { colors } from "../../styles/colors.stylex";
import { spacing } from "../../styles/spacing.stylex";
import { typography } from "../../styles/typography.stylex";
import { radii } from "../../styles/radii.stylex";
import { controls } from "../../styles/controls.stylex";

const buttonStyles = stylex.create({
  base: {
    borderColor: colors.controlBorder,
    borderRadius: radii.button,
    borderStyle: "solid",
    borderWidth: controls.borderWidth,
    gap: spacing.space8,
    paddingBlock: spacing.space10,
    paddingInline: 15,
    textDecoration: "none",
    alignItems: "center",
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    color: colors.secondaryText,
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    display: "inline-flex",
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightMedium,
    justifyContent: "center",
    lineHeight: typography.lineHeightControl,
    outlineColor: colors.focusRing,
    outlineOffset: controls.buttonFocusOffset,
    textAlign: "center",
    minHeight: 40,
  },
  primary: {
    borderColor: { default: colors.primary, ":disabled": colors.controlBorder },
    backgroundColor: {
      default: colors.primary,
      ":hover:not(:disabled)": colors.primaryHover,
      ":disabled": colors.disabledBackground,
    },
    color: { default: colors.onPrimary, ":disabled": colors.textMuted },
  },
});

export default buttonStyles;
