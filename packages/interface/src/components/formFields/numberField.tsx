import { Field } from "@base-ui/react/field";
import { NumberField as BaseNumberField } from "@base-ui/react/number-field";
import * as stylex from "@stylexjs/stylex";
import formContexts from "../../forms/formContexts";
import inputStyles from "../input/inputStyles";
import styles from "./fieldStyles";

type Props = { label: string; style?: stylex.StyleXStyles };

export default function NumberField({ label, style }: Props) {
  const field = formContexts.useFieldContext<number | null>();

  return (
    <Field.Root
      name={field.name}
      dirty={field.state.meta.isDirty}
      touched={field.state.meta.isTouched}
      invalid={!field.state.meta.isValid}
      {...stylex.props(styles.field, style)}
    >
      <Field.Label {...stylex.props(styles.label)}>{label}</Field.Label>
      <BaseNumberField.Root
        name={field.name}
        value={field.state.value}
        onValueChange={field.handleChange}
        format={{ useGrouping: false }}
      >
        <BaseNumberField.Input onBlur={field.handleBlur} {...stylex.props(inputStyles.input)} />
      </BaseNumberField.Root>
      {field.state.meta.errors.length > 0 && (
        <Field.Error match {...stylex.props(styles.error)}>
          {field.state.meta.errors.map((error) => error?.message).join(" ")}
        </Field.Error>
      )}
    </Field.Root>
  );
}
