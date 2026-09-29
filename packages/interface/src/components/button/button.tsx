import { Button as BaseButton } from "@base-ui/react/button";
import * as stylex from "@stylexjs/stylex";
import buttonStyles from "./buttonStyles";

type Props = Omit<BaseButton.Props, "className" | "style"> & {
  variant?: "primary" | "secondary";
};

export default function Button({ variant = "secondary", ...props }: Props) {
  return (
    <BaseButton
      {...props}
      {...stylex.props(buttonStyles.base, variant === "primary" && buttonStyles.primary)}
    />
  );
}
