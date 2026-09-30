import * as stylex from '@stylexjs/stylex';
import {isCancelledError, useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useLocation} from '@tanstack/react-router';
import {useEffect, useState, useSyncExternalStore} from 'react';

import {customerListOptions} from '../application/customers';
import Button from '../components/button/button';
import buttonStyles from '../components/button/buttonStyles';
import Input from '../components/input/input';
import PageShell from '../components/pageShell/pageShell';
import Table from '../components/table/table';
import {breakpoints} from '../styles/breakpoints.stylex';
import {colors} from '../styles/colors.stylex';
import {controls} from '../styles/controls.stylex';
import {radii} from '../styles/radii.stylex';
import {spacing} from '../styles/spacing.stylex';
import {typography} from '../styles/typography.stylex';

export const Route = createFileRoute('/customers')({component: RouteComponent});

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
  const location = useLocation();
  const notice = Reflect.get(location.state, 'customerNotice');
  const navigate = Route.useNavigate();
  const [draftSearch, setDraftSearch] = useState({committed: q, value: q});
  const input = draftSearch.committed === q ? draftSearch.value : q;
  function setInput(value: string) {
    setDraftSearch({committed: q, value});
  }

  const session = state.database?.session ?? '';
  const available = state.database?.available === true && !state.recoveryRequired;
  const disabled =
    !available || state.pendingTransition || state.reconciling || protection.frozen;
  const customers = useQuery({
    ...customerListOptions(application, session, q),
    enabled: !disabled,
  });

  useEffect(() => {
    if (input === q || disabled) {
      return;
    }

    const timeout = setTimeout(() => {
      void navigate({
        search: previous => ({...previous, q: input || undefined}),
        replace: true,
      });
    }, 250);
    return () => clearTimeout(timeout);
  }, [input, q, disabled, navigate]);

  return (
    <PageShell
      title="Customers"
      actions={
        disabled ? (
          <Button disabled>Add customer</Button>
        ) : (
          <Link
            to="/customers/new"
            search={previous => previous}
            {...stylex.props(buttonStyles.base)}
          >
            Add customer
          </Link>
        )
      }
    >
      <label htmlFor="search-customers" {...stylex.props(styles.searchLabel)}>
        Search customers
      </label>
      {typeof notice === 'string' && <p role="status">{notice}</p>}
      <div {...stylex.props(styles.search)}>
        <Input
          id="search-customers"
          name="search"
          value={input}
          disabled={disabled}
          placeholder="Name or customer number"
          onValueChange={setInput}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void navigate({
                search: previous => ({...previous, q: input || undefined}),
                replace: true,
              });
            }
          }}
        />
        <Button
          disabled={disabled || (!input && !q)}
          onClick={() => {
            setInput('');
            void navigate({
              search: previous => ({...previous, q: undefined}),
              replace: true,
            });
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
      ) : customers.isPending || isCancelledError(customers.error) ? (
        <p role="status">Loading customers…</p>
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
                          search: previous => previous,
                        });
                      }}
                    >
                      <Table.Cell>{customer.customerNumber ?? 'Unassigned'}</Table.Cell>
                      <Table.Cell>
                        <Link
                          to="/customers/$customerId"
                          params={{customerId: String(customer.id)}}
                          search={previous => previous}
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
