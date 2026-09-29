export default interface Customer {
  customerNumber: number;
  firstName: string;
  lastName: string;
  address: string;
  city: string;
  province: string;
  postalCode: string;
  homePhone: string;
  email: string;
  stock: number;
  balance: number;
  previousBalance: number;
  donate: boolean;
  comments: string;
}
