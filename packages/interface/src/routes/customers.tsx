import * as stylex from '@stylexjs/stylex';
import {useDebouncedCallback} from '@tanstack/react-pacer';
import {isCancelledError, useQuery} from '@tanstack/react-query';
import {
  createFileRoute,
  Link,
  useLocation,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import {useEffect, useState, useSyncExternalStore} from 'react';
import {z} from 'zod';

import {customerListOptions} from '../application/customers';
import {admitCustomerRoute} from '../application/routing';
import Button from '../components/button/button';
import buttonStyles from '../components/button/buttonStyles';
import {
  CustomerRouteError,
  CustomerRoutePending,
} from '../components/customerRouteFeedback/customerRouteFeedback';
import Input from '../components/input/input';
import LoadingSpinner from '../components/loadingSpinner/loadingSpinner';
import PageShell from '../components/pageShell/pageShell';
import {breakpoints} from '../styles/breakpoints.stylex';
import {colors} from '../styles/colors.stylex';
import {controls} from '../styles/controls.stylex';
import {radii} from '../styles/radii.stylex';
import {spacing} from '../styles/spacing.stylex';
import {typography} from '../styles/typography.stylex';

const customerSearchSchema = z.object({q: z.string().optional().catch(undefined)});

export const Route = createFileRoute('/customers')({
  validateSearch: customerSearchSchema,
  loaderDeps: ({search}) => ({q: search.q ?? ''}),
  beforeLoad: admitCustomerRoute,
  loader: async ({
    context: {application, queryClient, session, readScope},
    deps,
    preload,
  }) => {
    if (session && readScope) {
      await queryClient.fetchQuery(
        customerListOptions(application, session, deps.q, {
          ...readScope,
          coalesceKey: preload ? 'customers:preload:list' : 'customers:list',
        })
      );
    }
  },
  pendingComponent: CustomerRoutePending,
  pendingMs: Infinity,
  errorComponent: CustomerRouteError,
  component: RouteComponent,
});

const styles = stylex.create({
  searchLabel: {
    display: 'block',
    fontWeight: typography.fontWeightBold,
    marginBottom: spacing.space6,
  },
  search: {
    gap: spacing.space12,
    alignItems: 'center',
    display: 'grid',
    gridTemplateColumns: {default: 'minmax(0, 1fr) 112px', [breakpoints.compact]: '1fr'},
  },
  count: {marginBlock: spacing.space8, color: colors.textMuted, textAlign: 'right'},
  empty: {
    borderColor: colors.border,
    borderRadius: radii.large,
    borderStyle: 'solid',
    borderWidth: controls.borderWidth,
    paddingBlock: 52,
    paddingInline: {default: 40, [breakpoints.compact]: spacing.space20},
    backgroundColor: colors.surface,
  },
  emptyTitle: {fontSize: typography.fontSizeHeading, marginBottom: spacing.space20},
  directory: {
    margin: 0,
    padding: 0,
    borderColor: colors.border,
    borderRadius: radii.panel,
    borderStyle: 'solid',
    borderWidth: controls.borderWidth,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    listStyleType: 'none',
  },
  customerLink: {
    gap: spacing.space20,
    paddingBlock: spacing.space20,
    paddingInline: spacing.space22,
    textDecoration: 'none',
    alignItems: 'center',
    backgroundColor: {default: colors.surface, ':hover': colors.rowHover},
    color: colors.text,
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(180px, 2fr) minmax(150px, 1.2fr) 85px 100px 70px',
      [breakpoints.columns]: 'minmax(0, 1fr) 70px',
    },
    outlineColor: colors.focusRing,
    outlineOffset: -3,
    borderBottomColor: colors.border,
    borderBottomStyle: 'solid',
    borderBottomWidth: controls.borderWidth,
  },
  name: {
    fontSize: 25,
    fontWeight: typography.fontWeightRegular,
    overflowWrap: 'anywhere',
  },
  detail: {
    color: colors.textMuted,
    display: 'block',
    fontSize: typography.fontSizeSmall,
    marginTop: spacing.space4,
  },
  secondary: {display: {default: 'block', [breakpoints.columns]: 'none'}},
  amount: {
    display: {default: 'block', [breakpoints.columns]: 'none'},
    textAlign: 'right',
  },
  open: {
    color: colors.primary,
    fontWeight: typography.fontWeightSemibold,
    textAlign: 'right',
  },
});

function RouteComponent() {
  const {application} = Route.useRouteContext();
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const protection = useSyncExternalStore(
    application.protection.subscribe,
    application.protection.getState
  );
  const {q = ''} = Route.useSearch();
  const searching = useRouterState({
    select: router => router.isLoading && router.location.pathname === '/customers',
  });
  const location = useLocation();
  const notice = Reflect.get(location.state, 'customerNotice');
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [input, setInput] = useState(q);

  useEffect(
    () =>
      router.subscribe('onBeforeNavigate', ({toLocation}) => {
        if (toLocation.pathname === '/customers') {
          setInput(customerSearchSchema.parse(toLocation.search).q ?? '');
        }
      }),
    [router]
  );

  const session = state.database?.session ?? '';
  const available = state.database?.available === true && !state.recoveryRequired;
  const disabled =
    !available ||
    Boolean(state.pendingFile) ||
    state.pendingTransition ||
    state.reconciling ||
    protection.frozen;
  const customers = useQuery({
    ...customerListOptions(application, session, q),
    enabled: !disabled,
  });

  const rows = customers.data ?? [];

  function submitSearch(value: string) {
    if (!disabled && value !== (router.state.location.search.q ?? '')) {
      void navigate({search: {q: value || undefined}, replace: true});
    }
  }

  const search = useDebouncedCallback(
    (value: string) => {
      if (value === input) {
        submitSearch(value);
      }
    },
    {wait: 250, enabled: !disabled}
  );

  return (
    <PageShell
      title="Customers"
      actions={
        disabled ? (
          <Button variant="primary" disabled>
            Add customer
          </Button>
        ) : (
          <Link
            to="/customers/new"
            {...stylex.props(buttonStyles.base, buttonStyles.primary)}
          >
            Add customer
          </Link>
        )
      }
    >
      <label htmlFor="search-customers" {...stylex.props(styles.searchLabel)}>
        Search customers
      </label>
      {notice === 'Customer deleted.' && <p role="status">{notice}</p>}
      <div {...stylex.props(styles.search)}>
        <Input
          id="search-customers"
          name="search"
          value={input}
          disabled={disabled}
          placeholder="Name or customer number"
          onValueChange={value => {
            setInput(value);
            search(value);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitSearch(input);
            }
          }}
        />
        <Button
          disabled={disabled || (!input && !q)}
          onClick={() => {
            setInput('');
            void navigate({replace: true});
          }}
        >
          Clear
        </Button>
      </div>
      {!available ? (
        <p role="alert">
          {state.error ??
            'The database is unavailable. Open or retry the database to continue.'}
        </p>
      ) : searching || customers.isPending || isCancelledError(customers.error) ? (
        state.pendingFile || state.refreshingCustomers ? null : (
          <LoadingSpinner label="Loading customers…" />
        )
      ) : customers.isError && !customers.data ? (
        <section role="alert">
          <p>{customers.error.message}</p>
          <Button
            disabled={disabled}
            onClick={() => {
              void customers.refetch();
            }}
          >
            Retry
          </Button>
        </section>
      ) : (
        <>
          <p {...stylex.props(styles.count)}>
            {rows.length} {rows.length === 1 ? 'result' : 'results'}
          </p>
          {rows.length === 0 ? (
            <section {...stylex.props(styles.empty)}>
              <h2 {...stylex.props(styles.emptyTitle)}>
                {q ? 'No Matching Customers' : 'No Customers Yet'}
              </h2>
              <p>
                {q
                  ? 'Try a different name or customer number.'
                  : 'Add your first customer to start keeping records.'}
              </p>
            </section>
          ) : (
            <ul aria-label="Customers" {...stylex.props(styles.directory)}>
              {rows.map(({customer}) => (
                <li key={customer.id}>
                  <Link
                    to="/customers/$customerId"
                    params={{customerId: String(customer.id)}}
                    disabled={disabled}
                    aria-label={`${customer.firstName} ${customer.lastName}`.trim()}
                    aria-describedby={`customer-number-${customer.id} customer-contact-${customer.id} customer-stock-${customer.id} customer-balance-${customer.id}`}
                    {...stylex.props(styles.customerLink)}
                  >
                    <span>
                      <span {...stylex.props(styles.name)}>
                        {customer.firstName} {customer.lastName}
                      </span>
                      <span
                        id={`customer-number-${customer.id}`}
                        {...stylex.props(styles.detail)}
                      >
                        Customer {customer.customerNumber}
                      </span>
                    </span>
                    <span
                      id={`customer-contact-${customer.id}`}
                      {...stylex.props(styles.secondary)}
                    >
                      {customer.phone}
                      <span {...stylex.props(styles.detail)}>{customer.city}</span>
                    </span>
                    <span
                      id={`customer-stock-${customer.id}`}
                      {...stylex.props(styles.amount)}
                    >
                      {customer.stock}
                      <span {...stylex.props(styles.detail)}>In stock</span>
                    </span>
                    <span
                      id={`customer-balance-${customer.id}`}
                      {...stylex.props(styles.amount)}
                    >
                      ${customer.balance}
                      <span {...stylex.props(styles.detail)}>Balance</span>
                    </span>
                    <span {...stylex.props(styles.open)}>Open</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PageShell>
  );
}
