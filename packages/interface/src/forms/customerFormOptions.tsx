import { formOptions } from "@tanstack/react-form";
import type Customer from "../types/customer";

const defaultCustomer: Omit<Customer, "customerNumber"> = {
  firstName: "",
  lastName: "",
  address: "",
  city: "",
  province: "NS",
  postalCode: "",
  homePhone: "",
  email: "",
  stock: 0,
  balance: 0,
  previousBalance: 0,
  donate: false,
  comments: "",
};

export default function customerFormOptions(customerNumber: number) {
  return formOptions({
    defaultValues: {
      customerNumber,
      ...defaultCustomer,
    },
  });
}
