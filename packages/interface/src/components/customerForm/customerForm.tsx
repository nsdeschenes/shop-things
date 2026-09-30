import {Form} from '@base-ui/react/form';
import type {CustomerRecord} from '@shop-things/contract';
import {createCustomerInputSchema} from '@shop-things/contract/schemas';
import * as stylex from '@stylexjs/stylex';
import {isCancelledError, useMutation, useQueryClient} from '@tanstack/react-query';
import {Link, useNavigate} from '@tanstack/react-router';
import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';

import type {Application} from '../../application/controller';
import {
  createCustomerOptions,
  updateCustomerOptions,
  customerKeys,
  CustomerRequestError,
} from '../../application/customers';
import {sameDraftValues} from '../../application/protection';
import useDraftProtection from '../../application/useDraftProtection';
import customerFormOptions from '../../forms/customerFormOptions';
import useAppForm from '../../forms/useAppForm';
import {breakpoints} from '../../styles/breakpoints.stylex';
import {colors} from '../../styles/colors.stylex';
import {controls} from '../../styles/controls.stylex';
import {radii} from '../../styles/radii.stylex';
import {spacing} from '../../styles/spacing.stylex';
import {typography} from '../../styles/typography.stylex';
import Button from '../button/button';
import buttonStyles from '../button/buttonStyles';
import PageShell from '../pageShell/pageShell';

const identityFields = [
  {name: 'firstName', label: 'First name', inputMode: 'text'},
  {name: 'lastName', label: 'Last name', inputMode: 'text'},
  {name: 'address', label: 'Address', inputMode: 'text'},
  {name: 'city', label: 'City', inputMode: 'text'},
  {name: 'province', label: 'Province', inputMode: 'text'},
  {name: 'postalCode', label: 'Postal code', inputMode: 'text'},
  {name: 'homePhone', label: 'Home phone', inputMode: 'tel'},
  {name: 'email', label: 'Email address', inputMode: 'email'},
] as const;

const balanceFields = [
  {name: 'stock', label: 'Items in stock', inputMode: 'numeric'},
  {name: 'previousBalance', label: 'Previous balance ($)', inputMode: 'decimal'},
  {name: 'balance', label: 'Balance ($)', inputMode: 'decimal'},
] as const;

const styles = stylex.create({
  form: {gap: spacing.space22, display: 'flex', flexDirection: 'column'},
  column: {gap: spacing.space12, display: 'flex', flexDirection: 'column', minWidth: 0},
  topSections: {
    gap: spacing.space22,
    alignItems: 'stretch',
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(2, minmax(0, 1fr))',
      [breakpoints.columns]: '1fr',
    },
  },
  fieldset: {
    borderColor: colors.border,
    borderRadius: radii.panel,
    borderStyle: 'solid',
    borderWidth: controls.borderWidth,
    paddingInline: spacing.space20,
    backgroundColor: colors.surface,
    minWidth: 0,
    paddingBottom: spacing.space20,
    paddingTop: spacing.space8,
  },
  growingSection: {flexGrow: 1},
  compactFieldset: {paddingBottom: spacing.space12},
  legend: {
    paddingInline: spacing.space8,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightBold,
  },
  grid: {
    gap: spacing.space18,
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(2, minmax(0, 1fr))',
      [breakpoints.form]: '1fr',
    },
  },
  balanceGrid: {gridTemplateColumns: '1fr'},
  wide: {gridColumn: {default: 'span 2', [breakpoints.form]: 'auto'}},
  help: {
    color: colors.textMuted,
    fontSize: typography.fontSizeSmall,
    marginTop: spacing.space14,
  },
  actions: {gap: spacing.space10, display: 'flex'},
});

function focusInvalidField() {
  setTimeout(
    () =>
      document
        .querySelector<HTMLElement>(
          '[aria-invalid="true"] input, input[aria-invalid="true"]'
        )
        ?.focus(),
    0
  );
}

export default function CustomerForm({
  application,
  session,
  initialRecord,
  onSaved,
}: {
  application: Application;
  session: string;
  initialRecord?: CustomerRecord;
  onSaved?: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const create = useMutation(createCustomerOptions(application, session));
  const update = useMutation(updateCustomerOptions(application));
  const [saved, setSaved] = useState<CustomerRecord | null>(initialRecord ?? null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<'stale' | 'deleted' | null>(null);
  const [registered, setRegistered] = useState(false);
  const [defaults, setDefaults] = useState(
    customerFormOptions(initialRecord?.customer).defaultValues
  );
  const draftRef = useRef({
    baseline: defaults,
    saved: initialRecord
      ? structuredClone(initialRecord)
      : (null as CustomerRecord | null),
    submitting: false,
  });
  const form = useAppForm({
    ...customerFormOptions(initialRecord?.customer),
    defaultValues: defaults,
    onSubmitInvalid: focusInvalidField,
    onSubmit: async ({value}) => {
      if (
        blocked ||
        draftRef.current.submitting ||
        application.protection.getState().frozen
      ) {
        return;
      }

      draftRef.current.submitting = true;
      const submitted = {...value};
      const captured = application.captureSession(session);
      let completed: CustomerRecord | null = null;
      setError(null);
      try {
        await application.protection.save(async () => {
          try {
            const {customerNumber, ...editable} = submitted;
            const values = createCustomerInputSchema.parse({
              ...editable,
              stock: Number(submitted.stock),
            });
            const result = draftRef.current.saved
              ? await update.mutateAsync({
                  reference: draftRef.current.saved.reference,
                  changes: initialRecord
                    ? {...values, customerNumber: Number(customerNumber)}
                    : values,
                })
              : await create.mutateAsync(values);
            if (!captured.isCurrent()) {
              return;
            }

            draftRef.current.saved = result;
            setSaved(result);
            draftRef.current.baseline = submitted;
            queryClient.setQueryData(
              customerKeys.detail(session, result.customer.id),
              result
            );
            await queryClient.invalidateQueries({
              queryKey: customerKeys.session(session),
              predicate: query => query.queryKey[2] === 'list',
            });
            if (!captured.isCurrent()) {
              return;
            }

            queryClient.removeQueries({
              queryKey: customerKeys.session(session),
              predicate: query => query.queryKey[2] === 'list',
            });
            application.protection.changed();
            completed = result;
          } catch (failure) {
            if (captured.isCurrent() && !isCancelledError(failure)) {
              if (
                failure instanceof CustomerRequestError &&
                ['STALE_REVISION', 'CUSTOMER_DELETED'].includes(failure.error.code)
              ) {
                setBlocked(
                  failure.error.code === 'CUSTOMER_DELETED' ? 'deleted' : 'stale'
                );
              }

              const fields =
                failure instanceof CustomerRequestError
                  ? failure.error.fieldErrors
                  : undefined;
              for (const [name, message] of Object.entries(fields ?? {})) {
                if (name in submitted) {
                  form.setFieldMeta(name as keyof typeof submitted, previous => ({
                    ...previous,
                    errorMap: {...previous.errorMap, onSubmit: {message}},
                  }));
                }
              }

              setError(
                failure instanceof Error
                  ? failure.message
                  : 'Could not save the customer. Try again.'
              );
            }

            throw failure;
          }
        });
        const navigationState = application.getState();
        if (
          completed &&
          !navigationState.pendingTransition &&
          !navigationState.reconciling &&
          !navigationState.recoveryRequired &&
          captured.isCurrent() &&
          sameDraftValues(form.store.state.values, submitted)
        ) {
          const result: CustomerRecord = completed;
          application.protection.navigateAfterSave(() => {
            onSaved?.();
            void navigate({
              to: '/customers/$customerId',
              params: {customerId: String(result.customer.id)},
              search: previous => previous,
              state: previous => ({...previous, customerNotice: 'Customer saved.'}),
            });
          });
        }
      } catch {
        // Save feedback is settled inside the tracked renderer work.
      } finally {
        draftRef.current.submitting = false;
      }
    },
  });
  const editor = useMemo(
    () => ({
      values: () => form.store.state.values,
      baseline: () => draftRef.current.baseline,
      reset: () => {
        form.reset(draftRef.current.baseline);
      },
    }),
    [form]
  );
  const protection = useDraftProtection(application, editor);
  useEffect(() => {
    // Registration is an external protection capability; inputs wait for its effect.
    // oxlint-disable-next-line react/set-state-in-effect
    setRegistered(true);
    const subscription = form.store.subscribe(() => application.protection.changed());
    return () => subscription.unsubscribe();
  }, [application, form]);
  const unavailable =
    !state.database?.available ||
    state.database.session !== session ||
    state.recoveryRequired;
  const disabled =
    !registered ||
    protection.frozen ||
    unavailable ||
    state.reconciling ||
    state.pendingTransition;
  const pending = create.isPending || update.isPending || protection.saving;
  useEffect(() => {
    if (error && !disabled) {
      focusInvalidField();
    }
  }, [error, disabled]);

  async function reloadSavedCustomer() {
    const reference = draftRef.current.saved?.reference;
    if (!reference || disabled || pending || blocked === 'deleted') {
      return;
    }

    setError(null);
    try {
      await application.reloadCustomer(reference, record => {
        const baseline = customerFormOptions(record.customer).defaultValues;
        draftRef.current.saved = record;
        draftRef.current.baseline = baseline;
        setDefaults(baseline);
        form.reset(baseline);
        setSaved(record);
        setBlocked(null);
        queryClient.setQueryData(
          customerKeys.detail(session, record.customer.id),
          record
        );
        application.protection.changed();
      });
    } catch (failure) {
      if (!isCancelledError(failure)) {
        if (
          failure instanceof CustomerRequestError &&
          failure.error.code === 'CUSTOMER_DELETED'
        ) {
          setBlocked('deleted');
        }

        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not reload the customer. Try again.'
        );
      }
    }
  }

  return (
    <PageShell
      title={
        blocked === 'deleted'
          ? 'Customer not found'
          : initialRecord
            ? 'Edit Customer'
            : saved
              ? protection.dirty
                ? 'Customer saved — unsaved edits'
                : 'Customer saved'
              : 'New Customer'
      }
      stickyHeader
      actions={
        <div {...stylex.props(styles.actions)}>
          <Button
            variant="primary"
            disabled={disabled || pending || blocked !== null}
            onClick={() => form.handleSubmit()}
          >
            Save
          </Button>

          <Link
            to="/customers"
            search={previous => previous}
            {...stylex.props(buttonStyles.base)}
          >
            Cancel
          </Link>
        </div>
      }
    >
      {error && <p role="alert">{error}</p>}
      {blocked === 'stale' && (
        <p>
          The saved customer changed. Reload before saving again. Your edits are retained.
        </p>
      )}
      {blocked === 'deleted' && (
        <p>This customer no longer exists. Your edits are retained for copying.</p>
      )}
      {saved && blocked !== 'deleted' && (
        <section>
          <p>Reload saved customer replaces your draft with the saved values.</p>
          <Button
            disabled={disabled || pending}
            onClick={() => {
              void reloadSavedCustomer();
            }}
          >
            Reload customer
          </Button>
        </section>
      )}
      {unavailable && (
        <section role="alert">
          <p>The database is unavailable. Your edits are retained.</p>
          <p>{state.error}</p>
          <Button
            disabled={state.reconciling || state.pendingTransition || protection.frozen}
            onClick={() => {
              void application.reconcile();
            }}
          >
            Check database status
          </Button>
          <Button
            disabled={state.reconciling || state.pendingTransition || protection.frozen}
            onClick={() => {
              void application.transition('retry').then(result => {
                if (result.status === 'error') {
                  setError(result.error.message);
                }
              });
            }}
          >
            Retry database
          </Button>
        </section>
      )}
      {!initialRecord && (
        <p>Customer number: {saved?.customer.customerNumber ?? 'Assigned when saved'}</p>
      )}
      <Form
        noValidate
        onSubmit={event => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        {...stylex.props(styles.form)}
      >
        <div {...stylex.props(styles.topSections)}>
          <div {...stylex.props(styles.column)}>
            <fieldset
              disabled={disabled}
              {...stylex.props(styles.fieldset, styles.growingSection)}
            >
              <legend {...stylex.props(styles.legend)}>Identity and Contact</legend>
              <div {...stylex.props(styles.grid)}>
                {initialRecord && (
                  <form.AppField name="customerNumber">
                    {field => (
                      <field.TextField
                        readOnly={blocked === 'deleted'}
                        label="Customer number"
                        inputMode="numeric"
                        style={styles.wide}
                      />
                    )}
                  </form.AppField>
                )}
                {identityFields.map(config => (
                  <form.AppField key={config.name} name={config.name}>
                    {field => (
                      <field.TextField
                        readOnly={blocked === 'deleted'}
                        label={config.label}
                        inputMode={config.inputMode}
                        style={
                          config.name === 'address' || config.name === 'email'
                            ? styles.wide
                            : undefined
                        }
                      />
                    )}
                  </form.AppField>
                ))}
              </div>
              <p {...stylex.props(styles.help)}>
                Enter a first name, a last name, or both for a customer.
              </p>
            </fieldset>
            <fieldset
              disabled={disabled || blocked === 'deleted'}
              {...stylex.props(styles.fieldset, styles.compactFieldset)}
            >
              <legend {...stylex.props(styles.legend)}>Donation Preference</legend>
              <form.AppField name="donate">
                {field => <field.CheckboxField label="Donate" />}
              </form.AppField>
            </fieldset>
          </div>
          <div {...stylex.props(styles.column)}>
            <fieldset disabled={disabled} {...stylex.props(styles.fieldset)}>
              <legend {...stylex.props(styles.legend)}>Stock and Balances</legend>
              <div {...stylex.props(styles.grid, styles.balanceGrid)}>
                {balanceFields.map(config => (
                  <form.AppField key={config.name} name={config.name}>
                    {field => (
                      <field.TextField
                        readOnly={blocked === 'deleted'}
                        label={config.label}
                        inputMode={config.inputMode}
                      />
                    )}
                  </form.AppField>
                ))}
              </div>
              <p {...stylex.props(styles.help)}>
                Enter balances manually. Negative amounts are allowed; use at most two
                decimal places for new values.
              </p>
            </fieldset>

            <form.AppField name="comments">
              {field => (
                <field.TextareaField
                  disabled={disabled}
                  readOnly={blocked === 'deleted'}
                  label="Comments"
                  style={styles.growingSection}
                />
              )}
            </form.AppField>
          </div>
        </div>
      </Form>
    </PageShell>
  );
}
