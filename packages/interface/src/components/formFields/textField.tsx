import { Field } from "@base-ui/react/field";
import type { ComponentProps } from "react";
import * as stylex from "@stylexjs/stylex";
import Input from "../input/input";
import formContexts from "../../forms/formContexts";
import styles from "./fieldStyles";

type Props = {
  label: string;
  inputMode?: ComponentProps<typeof Input>["inputMode"];
  style?: stylex.StyleXStyles;
};

export default function TextField({ label, inputMode, style }: Props) {
  const field = formContexts.useFieldContext<string>();
  return (
    <Field.Root
      name={field.name}
      dirty={field.state.meta.isDirty}
      touched={field.state.meta.isTouched}
      invalid={!field.state.meta.isValid}
      {...stylex.props(styles.field, style)}
    >
      <Field.Label {...stylex.props(styles.label)}>{label}</Field.Label>
      <Input
        name={field.name}
        inputMode={inputMode}
        value={field.state.value}
        onBlur={field.handleBlur}
        onValueChange={field.handleChange}
      />
    </Field.Root>
  );
}
