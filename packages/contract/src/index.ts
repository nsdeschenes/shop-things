import type {z} from 'zod';

import type {
  actions,
  importReviewSchema,
  importRowSchema,
  customerSchema,
  customerRecordSchema,
  createCustomerInputSchema,
  updateCustomerInputSchema,
  customerTargetSchema,
  customerReferenceSchema,
  databaseStateSchema,
  migrationSnapshotSchema,
  errorCodeSchema,
  errorSchema,
  draftRequestSchema,
  draftReplySchema,
  draftResolutionSchema,
} from './schemas.js';
export type ImportReview = z.infer<typeof importReviewSchema>;
export type ImportRow = z.infer<typeof importRowSchema>;
export type Customer = z.infer<typeof customerSchema>;
export type CustomerRecord = z.infer<typeof customerRecordSchema>;
export type CreateCustomerInput = z.infer<typeof createCustomerInputSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerInputSchema>;
export type CustomerTarget = z.infer<typeof customerTargetSchema>;
export type CustomerReference = z.infer<typeof customerReferenceSchema>;
export type MigrationSnapshot = z.infer<typeof migrationSnapshotSchema>;
export type DatabaseState = z.infer<typeof databaseStateSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ContractError = z.infer<typeof errorSchema>;
export type DraftRequest = z.infer<typeof draftRequestSchema>;
export type DraftReply = z.infer<typeof draftReplySchema>;
export type DraftResolution = z.infer<typeof draftResolutionSchema>;
export type ActionName = keyof typeof actions;
export type ActionArguments = {
  [K in ActionName]: z.infer<(typeof actions)[K]['arguments']>;
};
export type ActionResults = {[K in ActionName]: z.infer<(typeof actions)[K]['result']>};
export type ActionMethod<K extends ActionName> = undefined extends ActionArguments[K]
  ? () => Promise<ActionResults[K]>
  : (args: ActionArguments[K]) => Promise<ActionResults[K]>;
export type ActionHandlers = {[K in ActionName]: ActionMethod<K>};

type Group<G extends string> = {
  [K in ActionName as K extends `${G}.${infer M}` ? M : never]: ActionMethod<K>;
};

export type DraftProtection = {
  prepare: (request: DraftRequest) => Promise<DraftReply>;
  resolve: (resolution: DraftResolution) => void;
};

export type ShopThingsBridge = {
  customers: Group<'customers'>;
  database: Group<'database'> & {
    onStateChanged: (callback: (state: DatabaseState) => void) => () => void;
  };
  imports: Group<'imports'>;
  exports: Group<'exports'>;
  drafts: Group<'drafts'> & {
    registerProtection: (protection: DraftProtection) => () => void;
  };
};

export type Client = ShopThingsBridge;
