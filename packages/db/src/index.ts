import { Database } from "@tursodatabase/database";
import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";

import * as schema from "./schema.js";

const relations = defineRelations(schema);

function createTypedDatabase(client: Database) {
  return drizzle({ client, relations });
}

export { schema };
export type AppDatabase = ReturnType<typeof createTypedDatabase>;

export interface DatabaseHandle {
  db: AppDatabase;
  close(): void;
}

export function openDatabase(databaseFilePath: string): DatabaseHandle {
  const client = new Database(databaseFilePath);

  return {
    db: createTypedDatabase(client),
    close: () => client.close(),
  };
}
