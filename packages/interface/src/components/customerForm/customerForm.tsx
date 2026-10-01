import {Field} from '@base-ui/react/field';
import {Form} from '@base-ui/react/form';
import type {CustomerRecord} from '@shop-things/contract';
import {createCustomerInputSchema} from '@shop-things/contract/schemas';
import * as stylex from '@stylexjs/stylex';
import {
  isCancelledError,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {Link, useNavigate} from '@tanstack/react-router';
import {useEffect, useId, useMemo, useRef, useState, useSyncExternalStore} from 'react';

import type {Application} from '../../application/controller';
import {
  createCustomerOptions,
  customerListOptions,
  updateCustomerOptions,
  customerKeys,
  CustomerRequestError,
} from '../../application/customers';
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
import DeleteCustomer from '../deleteCustomer/deleteCustomer';
import fieldStyles from '../formFields/fieldStyles';
import Input from '../input/input';
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
  fieldHelp: {marginTop: 0},
  actions: {gap: spacing.space10, display: 'flex'},
  saveStatus: {
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    position: 'absolute',
    whiteSpace: 'nowrap',
    height: 1,
    width: 1,
  },
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
  const formId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const create = useMutation(createCustomerOptions(application, session));
  const update = useMutation(updateCustomerOptions(application));
  const [savedRecord, setSavedRecord] = useState<CustomerRecord | null>(
    initialRecord ?? null
  );
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
    onSubmitInvalid: () => {
      application.toasts.error({
        title: 'Could not save customer',
        description: 'Check the highlighted fields and try again.',
      });
      focusInvalidField();
    },
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
            setSavedRecord(result);
            draftRef.current.baseline = submitted;
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
                void queryClient.invalidateQueries({
                  queryKey: customerKeys.session(session),
                  refetchType: 'none',
                });
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

              const message =
                failure instanceof Error
                  ? failure.message
                  : 'Could not save the customer. Try again.';
              setError(message);
              application.toasts.error({
                title: 'Could not save customer',
                description: message,
              });
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
          captured.isCurrent()
        ) {
          application.protection.navigateAfterSave(() => {
            onSaved?.();
            application.toasts.success({title: 'Customer saved'});
            void navigate({to: '/customers'});
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
  const customerList = useQuery({
    ...customerListOptions(application, session, ''),
    staleTime: 0,
    enabled: !initialRecord && !unavailable,
  });
  const nextCustomerNumber = useMemo(() => {
    if (!customerList.data) {
      return '';
    }

    const usedNumbers = new Set(
      customerList.data.map(record => record.customer.customerNumber)
    );
    let number = 1;
    while (usedNumbers.has(number)) {
      number++;
    }

    return String(number);
  }, [customerList.data]);
  const pending = create.isPending || update.isPending || protection.saving;
  const disabled =
    pending ||
    !registered ||
    protection.frozen ||
    unavailable ||
    state.reconciling ||
    state.pendingTransition;
  useEffect(() => {
    if (error && !disabled) {
      focusInvalidField();
    }
  }, [error, disabled]);

  async function reloadSavedCustomer() {
    const reference = draftRef.current.saved?.reference;
    if (!reference || disabled || blocked === 'deleted') {
      return;
    }

    setError(null);
    try {
      await application.reloadCustomer(reference, record => {
        const baseline = customerFormOptions(record.customer).defaultValues;
        draftRef.current.saved = record;
        setSavedRecord(record);
        draftRef.current.baseline = baseline;
        setDefaults(baseline);
        form.reset(baseline);
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
          ? 'Customer Not Found'
          : initialRecord
            ? `${savedRecord?.customer.firstName ?? ''} ${savedRecord?.customer.lastName ?? ''}`.trim()
            : 'New Customer'
      }
      stickyHeader
      actions={
        <div {...stylex.props(styles.actions)}>
          <Button
            variant="primary"
            busy={pending}
            disabled={disabled || blocked !== null}
            type="submit"
            form={formId}
          >
            Save
          </Button>

          <Link to="/customers" {...stylex.props(buttonStyles.base)}>
            {initialRecord ? 'Back to customers' : 'Cancel'}
          </Link>
          {initialRecord && savedRecord && blocked !== 'deleted' && (
            <DeleteCustomer
              key={`${savedRecord.reference.session}:${savedRecord.reference.id}`}
              application={application}
              record={savedRecord}
              disabled={disabled}
              busy={pending}
              onStale={() => setBlocked('stale')}
              onMissing={() => setBlocked('deleted')}
              showReload={false}
              onDeleted={() => {
                form.reset(draftRef.current.baseline);
                application.protection.changed();
                void navigate({
                  to: '/customers',
                  state: previous => ({...previous, customerNotice: 'Customer deleted.'}),
                });
              }}
            />
          )}
        </div>
      }
    >
      {pending && (
        <p role="status" {...stylex.props(styles.saveStatus)}>
          Saving customer…
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {blocked === 'stale' && (
        <p>
          The saved customer changed. Reload before saving again. Your edits are retained.
        </p>
      )}
      {blocked === 'deleted' && (
        <p>This customer no longer exists. Your edits are retained for copying.</p>
      )}
      {savedRecord && blocked !== 'deleted' && (
        <section>
          <p>Reload saved customer replaces your draft with the saved values.</p>
          <Button
            disabled={disabled}
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
      <Form
        id={formId}
        aria-label="Customer details"
        noValidate
        onSubmit={event => {
          event.preventDefault();
          if (!disabled && !blocked) {
            void form.handleSubmit();
          }
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
                {initialRecord ? (
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
                ) : (
                  <Field.Root disabled {...stylex.props(fieldStyles.field, styles.wide)}>
                    <Field.Label {...stylex.props(fieldStyles.label)}>
                      Customer number
                    </Field.Label>
                    <Input
                      disabled
                      value={
                        savedRecord?.customer.customerNumber !== undefined
                          ? String(savedRecord.customer.customerNumber ?? '')
                          : nextCustomerNumber
                      }
                    />
                    <Field.Description {...stylex.props(styles.help, styles.fieldHelp)}>
                      Automatically assigned when you save.
                    </Field.Description>
                  </Field.Root>
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
                {field => (
                  <field.CheckboxField
                    disabled={disabled || blocked === 'deleted'}
                    label="Donate"
                  />
                )}
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
