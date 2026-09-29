import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import Checkbox from "../checkbox/checkbox";
import formContexts from "../../forms/formContexts";
import styles from "./fieldStyles";

export default function CheckboxField({ label }: { label: string }) {
  const field = formContexts.useFieldContext<boolean>();
  return (
    <Field.Root
      name={field.name}
      dirty={field.state.meta.isDirty}
      touched={field.state.meta.isTouched}
      invalid={!field.state.meta.isValid}
    >
      <Field.Label {...stylex.props(styles.checkbox)}>
        <Checkbox
          name={field.name}
          checked={field.state.value}
          onCheckedChange={field.handleChange}
          onBlur={field.handleBlur}
        />
        {label}
      </Field.Label>
    </Field.Root>
  );
}
