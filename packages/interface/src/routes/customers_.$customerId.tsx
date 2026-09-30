import {createFileRoute} from '@tanstack/react-router';

import CustomerForm from '../components/customerForm/customerForm';
import previewCustomer from '../fixtures/previewCustomer';

export const Route = createFileRoute('/customers_/$customerId')({
  component: RouteComponent,
});

function RouteComponent() {
  const {customerId} = Route.useParams();
  return <CustomerForm key={customerId} customer={previewCustomer} />;
}
