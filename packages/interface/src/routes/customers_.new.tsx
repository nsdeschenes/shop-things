import {createFileRoute} from '@tanstack/react-router';

import CustomerForm from '../components/customerForm/customerForm';

export const Route = createFileRoute('/customers_/new')({
  component: RouteComponent,
});

function RouteComponent() {
  return <CustomerForm />;
}
