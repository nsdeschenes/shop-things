import { Input as BaseInput } from "@base-ui/react/input";
import * as stylex from "@stylexjs/stylex";
import inputStyles from "./inputStyles";

export default function Input(props: Omit<BaseInput.Props, "className" | "style">) {
  return <BaseInput {...props} {...stylex.props(inputStyles.input)} />;
}
