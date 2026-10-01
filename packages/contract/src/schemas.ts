import {z} from 'zod';

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const token = z.string().min(1);
const moneyInput = z.string().regex(/^-?\d+(?:\.\d{1,2})?$/);
const moneyOutput = z.string().regex(/^-?\d+\.\d{2}$/);
const editableFields = {
  firstName: z.string(),
  lastName: z.string(),
  address: z.string(),
  city: z.string(),
  province: z.string(),
  postalCode: z.string(),
  phone: z.string(),
  email: z.string(),
  stock: nonnegativeInteger,
  balance: moneyInput,
  previousBalance: moneyInput,
  donate: z.boolean(),
  comments: z.string(),
};

export const createCustomerInputSchema = z.strictObject(editableFields);

export const updateCustomerInputSchema = z
  .strictObject({...editableFields, customerNumber: positiveInteger})
  .partial();

export const customerSchema = z.strictObject({
  ...editableFields,
  id: positiveInteger,
  customerNumber: positiveInteger.nullable(),
  balance: moneyOutput,
  previousBalance: moneyOutput,
});

export const customerTargetSchema = z.strictObject({session: token, id: positiveInteger});

export const customerReferenceSchema = customerTargetSchema.extend({revision: token});

export const customerRecordSchema = z
  .strictObject({customer: customerSchema, reference: customerReferenceSchema})
  .refine(
    record => record.customer.id === record.reference.id,
    'Customer/reference IDs must match'
  );

export const errorCodeSchema = z.enum([
  'VALIDATION',
  'STALE_REVISION',
  'STALE_SESSION',
  'CUSTOMER_DELETED',
  'DATABASE_UNAVAILABLE',
  'BUSY',
  'INTERNAL',
  'UNAUTHORIZED',
]);

export const errorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string(),
  fieldErrors: z.record(z.string(), z.string()).optional(),
});

export const databaseStateSchema = z
  .strictObject({
    available: z.boolean(),
    selectedPath: token.nullable(),
    session: token.nullable(),
    version: nonnegativeInteger,
    recoveryError: errorSchema.optional(),
  })
  .refine(
    state =>
      state.available
        ? state.session !== null && state.selectedPath !== null
        : state.session === null,
    'Available state requires a path and session; unavailable state cannot have a session'
  );

export const draftRequestSchema = z.strictObject({requestId: token, documentId: token});

export const draftReplySchema = draftRequestSchema.extend({hasUnsavedDraft: z.boolean()});

export const draftResolutionSchema = draftRequestSchema.extend({
  outcome: z.enum(['committed', 'aborted']),
});

export function resultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('status', [
    z.strictObject({status: z.literal('success'), value}),
    z.strictObject({status: z.literal('cancelled')}),
    z.strictObject({status: z.literal('error'), error: errorSchema}),
  ]);
}

function action<A extends z.ZodType, R extends z.ZodType>(args: A, value: R) {
  return {arguments: args, result: resultSchema(value)};
}

const sessionArguments = z.strictObject({session: token});

export const importRowSchema = z.strictObject({
  recordNumber: positiveInteger,
  sourceCustomerNumber: positiveInteger.nullable(),
  assignedCustomerNumber: positiveInteger.nullable(),
  values: createCustomerInputSchema,
});
export const importReviewSchema = z.strictObject({
  importId: token,
  session: token,
  fileName: z.string(),
  status: z.enum(['ready', 'rejected', 'empty']),
  rows: z.array(importRowSchema),
  diagnostics: z.array(
    z.strictObject({
      recordNumber: positiveInteger.nullable(),
      column: z.string(),
      reason: z.string(),
    })
  ),
  invalidRecordCount: nonnegativeInteger,
  omittedDiagnosticCount: nonnegativeInteger,
  numberChangeCount: nonnegativeInteger,
});

export const actions = {
  'imports.prepare': action(sessionArguments, importReviewSchema),
  'imports.review': action(
    sessionArguments.extend({importId: token}),
    importReviewSchema
  ),
  'customers.list': action(
    sessionArguments.extend({query: z.string()}),
    z.array(customerRecordSchema)
  ),
  'customers.get': action(customerTargetSchema, customerRecordSchema),
  'customers.create': action(
    sessionArguments.extend({values: createCustomerInputSchema}),
    customerRecordSchema
  ),
  'customers.update': action(
    z.strictObject({
      reference: customerReferenceSchema,
      changes: updateCustomerInputSchema,
    }),
    customerRecordSchema
  ),
  'customers.delete': action(
    z.strictObject({reference: customerReferenceSchema}),
    z.strictObject({deleted: z.literal(true)})
  ),
  'database.status': action(z.undefined(), databaseStateSchema),
  'database.retry': action(z.undefined(), databaseStateSchema),
  'database.create': action(z.undefined(), databaseStateSchema),
  'database.open': action(z.undefined(), databaseStateSchema),
  'database.backup': action(sessionArguments, z.strictObject({path: token})),
  'database.restore': action(z.undefined(), databaseStateSchema),
  'exports.csv': action(sessionArguments, z.strictObject({path: token})),
  'drafts.confirmDiscard': action(
    z.undefined(),
    z.strictObject({approved: z.literal(true)})
  ),
};
