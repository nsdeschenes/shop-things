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
  .partial()
  .refine(
    value =>
      !Object.hasOwn(value, 'customerNumber') || value.customerNumber !== undefined,
    {path: ['customerNumber'], message: 'Customer number is required.'}
  );

export const customerSchema = z.strictObject({
  ...editableFields,
  id: positiveInteger,
  customerNumber: positiveInteger,
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

export const migrationSnapshotSchema = z.strictObject({
  snapshotId: z.string().uuid(),
  sourcePath: z.string().min(1).max(4096),
  createdAt: z.string().datetime(),
  sourceHistory: z.array(z.string().min(1).max(255)).min(1).max(256),
  targetHistory: z.array(z.string().min(1).max(255)).min(1).max(256),
});

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
  proposedCustomerNumber: positiveInteger.optional(),
  editedFields: z.array(z.enum(['email', 'phone'])).optional(),
  collisionFields: z.array(z.enum(['email', 'phone'])).optional(),
  values: createCustomerInputSchema,
  matches: z.array(token),
  choice: z.enum(['include', 'unresolved', 'add', 'skip']),
});
export const importMatchGroupSchema = z.strictObject({
  id: token,
  reason: z.enum(['name', 'email', 'phone']),
  targets: z.array(
    z.discriminatedUnion('kind', [
      z.strictObject({kind: z.literal('csv'), recordNumber: positiveInteger}),
      z.strictObject({
        kind: z.literal('customer'),
        id: positiveInteger,
        customerNumber: positiveInteger,
        firstName: z.string(),
        lastName: z.string(),
      }),
    ])
  ),
});
export const importReviewSchema = z.strictObject({
  importId: token,
  session: token,
  fileName: z.string(),
  status: z.enum(['ready', 'rejected', 'empty']),
  rows: z.array(importRowSchema),
  matchGroups: z.array(importMatchGroupSchema),
  diagnostics: z.array(
    z.strictObject({
      recordNumber: positiveInteger.nullable(),
      column: z.string(),
      reason: z.string(),
    })
  ),
  sourceRecordCount: nonnegativeInteger,
  includedCount: nonnegativeInteger,
  skippedCount: nonnegativeInteger,
  unresolvedCount: nonnegativeInteger,
  choicesResolved: z.boolean(),
  invalidRecordCount: nonnegativeInteger,
  omittedDiagnosticCount: nonnegativeInteger,
  numberChangeCount: nonnegativeInteger,
});

export const actions = {
  'imports.commit': action(
    sessionArguments.extend({importId: token}),
    z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('committed'),
        session: token,
        addedCount: nonnegativeInteger,
        skippedCount: nonnegativeInteger,
      }),
      z.strictObject({kind: z.literal('changed'), review: importReviewSchema}),
    ])
  ),
  'imports.prepare': action(sessionArguments, importReviewSchema),
  'imports.review': action(
    sessionArguments.extend({importId: token}),
    importReviewSchema
  ),
  'imports.resolve': action(
    z.union([
      sessionArguments.extend({
        importId: token,
        recordNumber: positiveInteger,
        choice: z.enum(['add', 'skip']),
      }),
      sessionArguments.extend({
        importId: token,
        recordNumber: positiveInteger,
        field: z.enum(['email', 'phone']),
        value: z.string(),
      }),
    ]),
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
  'database.listMigrationSnapshots': action(
    z.strictObject({}),
    z.strictObject({
      snapshots: z.array(migrationSnapshotSchema),
      unavailableCount: nonnegativeInteger,
    })
  ),
  'database.restoreMigrationSnapshot': action(
    z.strictObject({snapshotId: z.string().uuid()}),
    databaseStateSchema
  ),
  'exports.csv': action(sessionArguments, z.strictObject({path: token})),
  'drafts.confirmDiscard': action(
    z.undefined(),
    z.strictObject({approved: z.literal(true)})
  ),
};

const updateToken = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const updateStateSchema = z.strictObject({
  revision: nonnegativeInteger,
  phase: z.enum([
    'idle',
    'checking',
    'current',
    'available',
    'check-failed',
    'downloading',
    'verifying',
    'preparing',
    'quiescent',
    'authenticating',
    'installing',
    'reconciling',
    'restarting',
    'retryable-failure',
    'package-recovery',
  ]),
  candidateId: updateToken.optional(),
  attemptId: updateToken.optional(),
  targetVersion: z.string().min(1).max(128).optional(),
  progress: z.number().min(0).max(1).optional(),
  capabilityReasons: z.array(z.string().min(1).max(256)).max(16),
  errorCode: z
    .enum([
      'NETWORK',
      'RATE_LIMIT',
      'DISCOVERY_LIMIT',
      'TRUST_UNAVAILABLE',
      'INSTALL_UNAVAILABLE',
      'VERIFICATION',
      'AUTHENTICATION',
      'PACKAGE_LOCK',
      'PACKAGE_UNCERTAIN',
      'LAUNCH_FAILED',
    ])
    .optional(),
  nextActions: z.array(z.enum(['check', 'update', 'retry', 'repair', 'launch'])).max(5),
});
export const updateActions = {
  'update.check': action(z.strictObject({}), updateStateSchema),
  'update.getState': action(z.strictObject({}), updateStateSchema),
  'update.start': action(z.strictObject({candidateId: updateToken}), updateStateSchema),
  'update.retry': action(z.strictObject({attemptId: updateToken}), updateStateSchema),
};

export const appReadyAction = action(
  z.strictObject({}),
  z.strictObject({acknowledged: z.literal(true)})
);
