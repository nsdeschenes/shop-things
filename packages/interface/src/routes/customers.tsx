import * as stylex from '@stylexjs/stylex';
import {createFileRoute, Link} from '@tanstack/react-router';
import {z} from 'zod';

import Button from '../components/button/button';
import buttonStyles from '../components/button/buttonStyles';
import Input from '../components/input/input';
import PageShell from '../components/pageShell/pageShell';
import Table from '../components/table/table';
import previewCustomer from '../fixtures/previewCustomer';
import {breakpoints} from '../styles/breakpoints.stylex';
import {colors} from '../styles/colors.stylex';
import {controls} from '../styles/controls.stylex';
import {radii} from '../styles/radii.stylex';
import {spacing} from '../styles/spacing.stylex';
import {typography} from '../styles/typography.stylex';

export const Route = createFileRoute('/customers')({
  validateSearch: z.object({
    preview: z.enum(['empty', 'opened', 'saved']).optional().catch(undefined),
  }),
  component: RouteComponent,
});

const styles = stylex.create({
  notice: {
    borderRadius: radii.button,
    paddingBlock: spacing.space16,
    paddingInline: spacing.space20,
    backgroundColor: colors.successBackground,
    color: colors.successText,
    marginBottom: spacing.space24,
  },
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
  const {preview} = Route.useSearch();
  const navigate = Route.useNavigate();
  const isEmpty = preview === 'empty' || preview === 'opened';
  return (
    <PageShell
      title="Customers"
      actions={
        <Link
          to="/customers/new"
          {...stylex.props(buttonStyles.base, buttonStyles.primary)}
        >
          Add customer
        </Link>
      }
      notice={
        (preview === 'opened' || preview === 'saved') && (
          <p {...stylex.props(styles.notice)}>
            {preview === 'opened' ? 'Database opened.' : 'Customer saved.'}
          </p>
        )
      }
    >
      <label htmlFor="search-customers" {...stylex.props(styles.searchLabel)}>
        Search customers
      </label>
      <div {...stylex.props(styles.search)}>
        <Input
          id="search-customers"
          name="search"
          placeholder="Name or customer number"
        />
        <Button disabled>Clear</Button>
      </div>
      <p {...stylex.props(styles.count)}>{isEmpty ? '0 customers' : '1 customer'}</p>
      {isEmpty ? (
        <section {...stylex.props(styles.empty)}>
          <h2 {...stylex.props(styles.emptyTitle)}>No Customers Yet</h2>
          <p>Add your first customer to start keeping records.</p>
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
              <Table.Row
                onClick={event => {
                  if (event.target instanceof Element && event.target.closest('a')) {
                    return;
                  }

                  void navigate({
                    to: '/customers/$customerId',
                    params: {customerId: String(previewCustomer.id)},
                  });
                }}
              >
                <Table.Cell>{previewCustomer.customerNumber}</Table.Cell>
                <Table.Cell>
                  <Link
                    to="/customers/$customerId"
                    params={{customerId: String(previewCustomer.id)}}
                    {...stylex.props(styles.customerLink)}
                  >
                    {previewCustomer.firstName} {previewCustomer.lastName}
                  </Link>
                </Table.Cell>
                <Table.Cell>{previewCustomer.homePhone}</Table.Cell>
                <Table.Cell align="right">{previewCustomer.stock}</Table.Cell>
                <Table.Cell align="right">
                  ${previewCustomer.balance.toFixed(2)}
                </Table.Cell>
              </Table.Row>
            </Table.Body>
          </Table>
        </Table.Container>
      )}
    </PageShell>
  );
}
