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
import Table from '../components/table/table';
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
  customerLink: {
    textDecoration: 'none',
    color: colors.primary,
    fontWeight: typography.fontWeightBold,
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
    !available || state.pendingTransition || state.reconciling || protection.frozen;
  const customers = useQuery({
    ...customerListOptions(application, session, q),
    enabled: !disabled,
  });

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
        <LoadingSpinner label="Loading customers…" />
      ) : customers.isError ? (
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
            {customers.data.length} {customers.data.length === 1 ? 'result' : 'results'}
          </p>
          {customers.data.length === 0 ? (
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
            <Table.Container>
              <Table>
                <Table.Head>
                  <Table.Row>
                    <Table.HeaderCell>#</Table.HeaderCell>
                    <Table.HeaderCell>Name</Table.HeaderCell>
                    <Table.HeaderCell>Home phone</Table.HeaderCell>
                    <Table.HeaderCell align="right">Items in stock</Table.HeaderCell>
                    <Table.HeaderCell align="right">Balance</Table.HeaderCell>
                  </Table.Row>
                </Table.Head>
                <Table.Body>
                  {customers.data.map(({customer}) => (
                    <Table.Row
                      key={customer.id}
                      onClick={event => {
                        if (
                          disabled ||
                          (event.target instanceof Element && event.target.closest('a'))
                        ) {
                          return;
                        }

                        void navigate({
                          to: '/customers/$customerId',
                          params: {customerId: String(customer.id)},
                        });
                      }}
                    >
                      <Table.Cell>{customer.customerNumber ?? 'Unassigned'}</Table.Cell>
                      <Table.Cell>
                        <Link
                          to="/customers/$customerId"
                          params={{customerId: String(customer.id)}}

                          disabled={disabled}
                          {...stylex.props(styles.customerLink)}
                        >
                          {customer.firstName} {customer.lastName}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>{customer.homePhone}</Table.Cell>
                      <Table.Cell align="right">{customer.stock}</Table.Cell>
                      <Table.Cell align="right">${customer.balance}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </Table.Container>
          )}
        </>
      )}
    </PageShell>
  );
}
