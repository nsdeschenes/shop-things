import { Field } from "@base-ui/react/field";
import type { ComponentProps } from "react";
import * as stylex from "@stylexjs/stylex";
import Input from "../input/input";
import formContexts from "../../forms/formContexts";
import styles from "./fieldStyles";

type Props = {
  label: string;
  inputMode?: ComponentProps<typeof Input>["inputMode"];
  uppercase?: boolean;
  style?: stylex.StyleXStyles;
};

export default function TextField({ label, inputMode, uppercase, style }: Props) {
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
        onValueChange={(value) => field.handleChange(uppercase ? value.toUpperCase() : value)}
      />
      {field.state.meta.errors.length > 0 && (
        <Field.Error match {...stylex.props(styles.error)}>
          {field.state.meta.errors.map((error) => error?.message).join(" ")}
        </Field.Error>
      )}
    </Field.Root>
  );
}
