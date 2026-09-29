import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import formContexts from "../../forms/formContexts";
import styles from "./fieldStyles";

type Props = { label: string; style?: stylex.StyleXStyles };

export default function TextareaField({ label, style }: Props) {
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
      <Field.Control
        render={<textarea />}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onValueChange={field.handleChange}
        {...stylex.props(styles.textarea)}
      />
    </Field.Root>
  );
}
