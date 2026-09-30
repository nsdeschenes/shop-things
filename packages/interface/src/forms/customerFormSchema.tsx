import {z} from 'zod';

const integerPattern = /^\d+$/;
const balancePattern = /^-?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/;

const stock = z
  .string()
  .refine(
    value => integerPattern.test(value) && Number.isSafeInteger(Number(value)),
    'Enter a whole number greater than or equal to 0.'
  );

const balance = z
  .string()
  .refine(
    value => balancePattern.test(value) && Number.isFinite(Number(value)),
    'Enter an amount with at most two decimal places.'
  );

const customerFormSchema = z.object({
  customerNumber: z
    .number({error: 'Enter a customer number.'})
    .nullable()
    .refine(value => value !== null, 'Enter a customer number.'),
  firstName: z.string(),
  lastName: z.string(),
  address: z.string(),
  city: z.string(),
  province: z.string(),
  postalCode: z.string(),
  homePhone: z.string().regex(/^\d*$/, 'Enter digits only (0–9).'),
  email: z.union([z.literal(''), z.email('Enter a valid email address.')]),
  stock,
  previousBalance: balance,
  balance,
  donate: z.boolean(),
  comments: z.string(),
});

export default customerFormSchema;
