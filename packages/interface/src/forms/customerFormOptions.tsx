import { formOptions } from "@tanstack/react-form";
import type Customer from "../types/customer";

export default function customerFormOptions(customer?: Customer) {
  return formOptions({
    defaultValues: {
      customerNumber: customer ? String(customer.customerNumber) : "",
      firstName: customer?.firstName ?? "",
      lastName: customer?.lastName ?? "",
      address: customer?.address ?? "",
      city: customer?.city ?? "",
      province: customer?.province ?? "",
      postalCode: customer?.postalCode ?? "",
      homePhone: customer?.homePhone ?? "",
      email: customer?.email ?? "",
      stock: String(customer?.stock ?? 0),
      previousBalance: (customer?.previousBalance ?? 0).toFixed(2),
      balance: (customer?.balance ?? 0).toFixed(2),
      donate: customer?.donate ?? false,
      comments: customer?.comments ?? "",
    },
  });
}
