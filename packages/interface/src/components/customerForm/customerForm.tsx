import { Form } from "@base-ui/react/form";
import { Link, useNavigate } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { colors } from "../../styles/colors.stylex";
import { spacing } from "../../styles/spacing.stylex";
import { typography } from "../../styles/typography.stylex";
import { radii } from "../../styles/radii.stylex";
import { controls } from "../../styles/controls.stylex";
import { breakpoints } from "../../styles/breakpoints.stylex";
import Button from "../button/button";
import buttonStyles from "../button/buttonStyles";
import PageShell from "../pageShell/pageShell";
import useAppForm from "../../forms/useAppForm";
import customerFormOptions from "../../forms/customerFormOptions";
import type Customer from "../../types/customer";

const identityFields = [
  { name: "customerNumber", label: "Customer number", inputMode: "numeric" },
  { name: "firstName", label: "First name", inputMode: "text" },
  { name: "lastName", label: "Last name", inputMode: "text" },
  { name: "address", label: "Address", inputMode: "text" },
  { name: "city", label: "City", inputMode: "text" },
  { name: "province", label: "Province", inputMode: "text" },
  { name: "postalCode", label: "Postal code", inputMode: "text" },
  { name: "homePhone", label: "Home phone", inputMode: "tel" },
  { name: "email", label: "Email address", inputMode: "email" },
] as const;

const balanceFields = [
  { name: "stock", label: "Items in stock", inputMode: "numeric" },
  { name: "previousBalance", label: "Previous balance ($)", inputMode: "decimal" },
  { name: "balance", label: "Balance ($)", inputMode: "decimal" },
] as const;

const styles = stylex.create({
  form: { gap: spacing.space22, display: "flex", flexDirection: "column" },
  column: { gap: spacing.space12, display: "flex", flexDirection: "column", minWidth: 0 },
  topSections: {
    gap: spacing.space22,
    alignItems: "stretch",
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      [breakpoints.columns]: "1fr",
    },
  },
  fieldset: {
    borderColor: colors.border,
    borderRadius: radii.panel,
    borderStyle: "solid",
    borderWidth: controls.borderWidth,
    paddingInline: spacing.space20,
    backgroundColor: colors.surface,
    minWidth: 0,
    paddingBottom: spacing.space20,
    paddingTop: spacing.space8,
  },
  growingSection: { flexGrow: 1 },
  compactFieldset: { paddingBottom: spacing.space12 },
  legend: {
    paddingInline: spacing.space8,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightBold,
  },
  grid: {
    gap: spacing.space18,
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      [breakpoints.form]: "1fr",
    },
  },
  balanceGrid: { gridTemplateColumns: "1fr" },
  wide: { gridColumn: { default: "span 2", [breakpoints.form]: "auto" } },
  help: { color: colors.textMuted, fontSize: typography.fontSizeSmall, marginTop: spacing.space14 },
  actions: { gap: spacing.space10, display: "flex" },
});

export default function CustomerForm({ customer }: { customer?: Customer }) {
  const navigate = useNavigate();
  const form = useAppForm({
    ...customerFormOptions(customer),
    onSubmit: () => navigate({ to: "/customers" }),
  });

  return (
    <PageShell
      title={customer ? "Edit Customer" : "New Customer"}
      stickyHeader
      actions={
        <div {...stylex.props(styles.actions)}>
          <form.Subscribe selector={(state) => state.isDefaultValue || !state.canSubmit}>
            {(disabled) => (
              <Button variant="primary" disabled={disabled} onClick={() => form.handleSubmit()}>
                Save
              </Button>
            )}
          </form.Subscribe>
          <Link to="/customers" {...stylex.props(buttonStyles.base)}>
            Cancel
          </Link>
        </div>
      }
    >
      <Form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        {...stylex.props(styles.form)}
      >
        <div {...stylex.props(styles.topSections)}>
          <div {...stylex.props(styles.column)}>
            <fieldset {...stylex.props(styles.fieldset, styles.growingSection)}>
              <legend {...stylex.props(styles.legend)}>Identity and Contact</legend>
              <div {...stylex.props(styles.grid)}>
                {identityFields.map((config) => (
                  <form.AppField key={config.name} name={config.name}>
                    {(field) =>
                      config.name === "customerNumber" ? (
                        <field.NumberField label={config.label} style={styles.wide} />
                      ) : config.name === "province" ? (
                        <field.ProvinceField />
                      ) : (
                        <field.TextField
                          label={config.label}
                          inputMode={config.inputMode}
                          uppercase={config.name === "postalCode"}
                          style={
                            config.name === "address" || config.name === "email"
                              ? styles.wide
                              : undefined
                          }
                        />
                      )
                    }
                  </form.AppField>
                ))}
              </div>
              <p {...stylex.props(styles.help)}>
                Enter a first name, a last name, or both for a customer.
              </p>
            </fieldset>
            <fieldset {...stylex.props(styles.fieldset, styles.compactFieldset)}>
              <legend {...stylex.props(styles.legend)}>Donation Preference</legend>
              <form.AppField name="donate">
                {(field) => <field.CheckboxField label="Donate" />}
              </form.AppField>
            </fieldset>
          </div>
          <div {...stylex.props(styles.column)}>
            <fieldset {...stylex.props(styles.fieldset)}>
              <legend {...stylex.props(styles.legend)}>Stock and Balances</legend>
              <div {...stylex.props(styles.grid, styles.balanceGrid)}>
                {balanceFields.map((config) => (
                  <form.AppField key={config.name} name={config.name}>
                    {(field) => (
                      <field.TextField label={config.label} inputMode={config.inputMode} />
                    )}
                  </form.AppField>
                ))}
              </div>
              <p {...stylex.props(styles.help)}>
                Enter balances manually. Negative amounts are allowed; use at most two decimal
                places for new values.
              </p>
            </fieldset>

            <form.AppField name="comments">
              {(field) => <field.TextareaField label="Comments" style={styles.growingSection} />}
            </form.AppField>
          </div>
        </div>
      </Form>
    </PageShell>
  );
}
