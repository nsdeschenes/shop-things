import * as stylex from '@stylexjs/stylex';
import {isCancelledError, useQuery} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {useSyncExternalStore} from 'react';

import {CustomerRequestError, customerDetailOptions} from '../application/customers';
import Button from '../components/button/button';
import buttonStyles from '../components/button/buttonStyles';
import PageShell from '../components/pageShell/pageShell';
import {breakpoints} from '../styles/breakpoints.stylex';
import {colors} from '../styles/colors.stylex';
import {controls} from '../styles/controls.stylex';
import {radii} from '../styles/radii.stylex';
import {spacing} from '../styles/spacing.stylex';
import {typography} from '../styles/typography.stylex';

export const Route = createFileRoute('/customers_/$customerId')({
  component: RouteComponent,
});

const customerIdPattern = /^\d+$/;

const styles = stylex.create({
  actions: {gap: spacing.space10, display: 'flex', flexWrap: 'wrap'},
  details: {
    gap: spacing.space22,
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(2, minmax(0, 1fr))',
      [breakpoints.columns]: '1fr',
    },
  },
  section: {
    padding: spacing.space20,
    borderColor: colors.border,
    borderRadius: radii.panel,
    borderStyle: 'solid',
    borderWidth: controls.borderWidth,
    backgroundColor: colors.surface,
    minWidth: 0,
  },
  heading: {
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightBold,
    marginBottom: spacing.space18,
  },
  field: {
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
    marginBottom: spacing.space12,
  },
  label: {fontWeight: typography.fontWeightBold, marginBottom: spacing.space4},
});

function RouteComponent() {
  const {application} = Route.useRouteContext();
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const protection = useSyncExternalStore(
    application.protection.subscribe,
    application.protection.getState
  );
  const {customerId} = Route.useParams();
  const id = Number(customerId);
  const validId =
    customerIdPattern.test(customerId) && Number.isSafeInteger(id) && id > 0;
  const session = state.database?.session ?? '';
  const available = state.database?.available === true && !state.recoveryRequired;
  const disabled =
    !available || state.pendingTransition || state.reconciling || protection.frozen;
  const record = useQuery({
    ...customerDetailOptions(application, session, id),
    enabled: !disabled && validId,
  });
  const missing =
    !validId ||
    (record.error instanceof CustomerRequestError &&
      record.error.error.code === 'CUSTOMER_DELETED');
  const customer = record.data?.customer;
  const back = (
    <Link
      to="/customers"
      search={previous => previous}
      {...stylex.props(buttonStyles.base)}
    >
      Back to customers
    </Link>
  );

  if (missing) {
    return (
      <PageShell title="Customer not found" actions={back}>
        <p>This customer no longer exists.</p>
      </PageShell>
    );
  }

  if (!available) {
    return (
      <PageShell title="Customer" actions={back}>
        <p role="alert">
          {state.error ??
            'The database is unavailable. Open or retry the database to continue.'}
        </p>
      </PageShell>
    );
  }

  if (
    record.isPending ||
    isCancelledError(record.error) ||
    (!customer && !record.isError)
  ) {
    return (
      <PageShell title="Customer" actions={back}>
        <p role="status">Loading customer…</p>
      </PageShell>
    );
  }

  if (record.isError) {
    return (
      <PageShell title="Customer" actions={back}>
        <section role="alert">
          <p>{record.error.message}</p>
          <Button
            disabled={disabled}
            onClick={() => {
              void record.refetch();
            }}
          >
            Retry
          </Button>
        </section>
      </PageShell>
    );
  }

  if (!customer) {
    return null;
  }

  const contact: [string, string | number][] = [
    ['Customer number', customer.customerNumber ?? 'Unassigned'],
    ['First name', customer.firstName],
    ['Last name', customer.lastName],
    ['Address', customer.address],
    ['City', customer.city],
    ['Province', customer.province],
    ['Postal code', customer.postalCode],
    ['Home phone', customer.homePhone],
    ['Email address', customer.email],
  ];
  const balances: [string, string | number][] = [
    ['Items in stock', customer.stock],
    ['Previous balance', `$${customer.previousBalance}`],
    ['Balance', `$${customer.balance}`],
    ['Donate', customer.donate ? 'Yes' : 'No'],
    ['Comments', customer.comments],
  ];
  const sections = [
    {heading: 'Identity and Contact', fields: contact},
    {heading: 'Stock and Balances', fields: balances},
  ];
  return (
    <PageShell
      title={`${customer.firstName} ${customer.lastName}`.trim()}
      actions={
        <div {...stylex.props(styles.actions)}>
          {back}
          <Button disabled>Edit customer</Button>
          <Button disabled>Delete customer</Button>
        </div>
      }
    >
      <div {...stylex.props(styles.details)}>
        {sections.map(({heading, fields}) => (
          <section key={heading} {...stylex.props(styles.section)}>
            <h2 {...stylex.props(styles.heading)}>{heading}</h2>
            <dl>
              {fields.map(([label, value]) => (
                <div key={label} {...stylex.props(styles.field)}>
                  <dt {...stylex.props(styles.label)}>{label}</dt>
                  <dd>{value === '' ? '—' : value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </PageShell>
  );
}
