import * as stylex from '@stylexjs/stylex';
import {createFileRoute} from '@tanstack/react-router';

import Button from '../components/button/button';
import Input from '../components/input/input';
import PageShell from '../components/pageShell/pageShell';
import {breakpoints} from '../styles/breakpoints.stylex';
import {spacing} from '../styles/spacing.stylex';
import {typography} from '../styles/typography.stylex';

export const Route = createFileRoute('/customers')({
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
});

function RouteComponent() {
  return (
    <PageShell title="Customers" actions={<Button disabled>Add customer</Button>}>
      <label htmlFor="search-customers" {...stylex.props(styles.searchLabel)}>
        Search customers
      </label>
      <div {...stylex.props(styles.search)}>
        <Input id="search-customers" disabled placeholder="Name or customer number" />
        <Button disabled>Clear</Button>
      </div>
      <p>
        Customer records will be available after database and draft protection are
        connected.
      </p>
    </PageShell>
  );
}
