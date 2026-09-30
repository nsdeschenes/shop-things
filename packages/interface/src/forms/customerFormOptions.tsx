import {formOptions} from '@tanstack/react-form';

import customerFormSchema from './customerFormSchema';

export default function customerFormOptions() {
  return formOptions({
    validators: {onBlur: customerFormSchema, onSubmit: customerFormSchema},
    defaultValues: {
      firstName: '',
      lastName: '',
      address: '',
      city: '',
      province: '',
      postalCode: '',
      homePhone: '',
      email: '',
      stock: '0',
      previousBalance: '0.00',
      balance: '0.00',
      donate: false,
      comments: '',
    },
  });
}
