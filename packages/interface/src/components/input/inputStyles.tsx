import * as stylex from "@stylexjs/stylex";
import { colors } from "../../styles/colors.stylex";
import { spacing } from "../../styles/spacing.stylex";
import { typography } from "../../styles/typography.stylex";
import { radii } from "../../styles/radii.stylex";
import { controls } from "../../styles/controls.stylex";

const inputStyles = stylex.create({
  input: {
    borderColor: colors.controlBorder,
    borderRadius: radii.control,
    borderStyle: "solid",
    borderWidth: controls.borderWidth,
    paddingBlock: spacing.space10,
    paddingInline: spacing.space12,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightRegular,
    lineHeight: typography.lineHeightControl,
    outlineColor: colors.focusRing,
    outlineOffset: controls.focusOffset,
    minHeight: 42,
    minWidth: 0,
    width: "100%",
    "::placeholder": { color: colors.placeholder },
  },
});

export default inputStyles;
