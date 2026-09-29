import { formOptions } from "@tanstack/react-form";
import type Customer from "../types/customer";
import customerFormSchema from "./customerFormSchema";

export default function customerFormOptions(customer?: Customer) {
  return formOptions({
    validators: {
      onChange: customerFormSchema,
      onSubmit: customerFormSchema,
    },
    defaultValues: {
      customerNumber: customer?.customerNumber ?? null,
      firstName: customer?.firstName ?? "",
      lastName: customer?.lastName ?? "",
      address: customer?.address ?? "",
      city: customer?.city ?? "",
      province: customer?.province.toUpperCase() || "NS",
      postalCode: (customer?.postalCode ?? "").toUpperCase(),
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
