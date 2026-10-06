import type {Customer} from '@shop-things/contract';
import {formOptions} from '@tanstack/react-form';

import customerFormSchema from './customerFormSchema';

export default function customerFormOptions(customer?: Customer) {
  return formOptions({
    validators: {
      onMount: customerFormSchema(Boolean(customer)),
      onChange: customerFormSchema(Boolean(customer)),
      onBlur: customerFormSchema(Boolean(customer)),
      onSubmit: customerFormSchema(Boolean(customer)),
    },
    defaultValues: {
      customerNumber: customer ? String(customer.customerNumber) : '',
      firstName: customer?.firstName ?? '',
      lastName: customer?.lastName ?? '',
      address: customer?.address ?? '',
      city: customer?.city ?? '',
      province: customer?.province.toUpperCase() || 'NS',
      postalCode: (customer?.postalCode ?? '').toUpperCase(),
      phone: customer?.phone ?? '',
      email: customer?.email ?? '',
      stock: String(customer?.stock ?? 0),
      previousBalance: customer?.previousBalance ?? '0.00',
      balance: customer?.balance ?? '0.00',
      donate: customer?.donate ?? false,
      comments: customer?.comments ?? '',
    },
  });
}
