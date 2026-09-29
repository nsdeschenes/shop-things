import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import * as stylex from "@stylexjs/stylex";
import { colors } from "../../styles/colors.stylex";
import { typography } from "../../styles/typography.stylex";
import { radii } from "../../styles/radii.stylex";
import { controls } from "../../styles/controls.stylex";

const styles = stylex.create({
  root: {
    padding: 0,
    borderColor: colors.checkboxBorder,
    borderRadius: radii.checkbox,
    borderStyle: "solid",
    borderWidth: controls.borderWidth,
    alignItems: "center",
    backgroundColor: colors.surface,
    color: colors.primary,
    cursor: "pointer",
    display: "inline-flex",
    flexShrink: 0,
    justifyContent: "center",
    outlineColor: colors.focusRing,
    outlineOffset: controls.buttonFocusOffset,
    height: 18,
    width: 18,
  },
  indicator: { fontSize: 15, fontWeight: typography.fontWeightBold, lineHeight: 1 },
});

export default function Checkbox(props: Omit<BaseCheckbox.Root.Props, "className" | "style">) {
  return (
    <BaseCheckbox.Root {...props} {...stylex.props(styles.root)}>
      <BaseCheckbox.Indicator aria-hidden="true" {...stylex.props(styles.indicator)}>
        ✓
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
