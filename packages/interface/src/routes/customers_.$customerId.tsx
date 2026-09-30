import {createFileRoute} from '@tanstack/react-router';

import Button from '../components/button/button';
import PageShell from '../components/pageShell/pageShell';

export const Route = createFileRoute('/customers_/$customerId')({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <PageShell
      title="Customer Editing Unavailable"
      actions={<Button disabled>Save</Button>}
    >
      <p>Customer editing will be available after draft protection is connected.</p>
    </PageShell>
  );
}
