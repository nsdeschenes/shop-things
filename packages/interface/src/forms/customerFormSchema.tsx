import {
  createCustomerInputSchema,
  updateCustomerInputSchema,
} from '@shop-things/contract/schemas';
import {z} from 'zod';

const integerPattern = /^\d+$/;

const balance = z
  .string()
  .refine(
    value => createCustomerInputSchema.shape.balance.safeParse(value).success,
    'Enter an amount with at most two decimal places.'
  );

function customerFormSchema(editing = false) {
  return createCustomerInputSchema
    .extend({
      customerNumber: z.string(),
      stock: z
        .string()
        .refine(
          value => integerPattern.test(value) && Number.isSafeInteger(Number(value)),
          'Enter a whole number greater than or equal to 0.'
        ),
      balance: balance,
      previousBalance: balance,
    })
    .superRefine((value, context) => {
      if (
        editing &&
        (!integerPattern.test(value.customerNumber) ||
          !updateCustomerInputSchema.shape.customerNumber.safeParse(
            Number(value.customerNumber)
          ).success)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['customerNumber'],
          message: 'Enter a positive whole customer number.',
        });
      }

      if (!value.firstName.trim() && !value.lastName.trim()) {
        context.addIssue({
          code: 'custom',
          path: ['firstName'],
          message: 'Enter a first name, a last name, or both.',
        });
      }
    });
}

export default customerFormSchema;
