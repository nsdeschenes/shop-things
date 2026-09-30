import type Customer from '../types/customer';

const previewCustomer: Customer & {id: number} = {
  id: 1,
  customerNumber: 1001,
  firstName: 'Test',
  lastName: 'User',
  address: '',
  city: '',
  province: '',
  postalCode: '',
  homePhone: '',
  email: '',
  stock: 0,
  previousBalance: 0,
  balance: 0,
  donate: false,
  comments: '',
};

export default previewCustomer;
