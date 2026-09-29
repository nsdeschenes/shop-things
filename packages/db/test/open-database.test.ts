import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { openDatabase } from "@shop-things/db";

test("opens and closes a caller-selected database file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-things-db-"));
  const databaseFilePath = join(directory, "app.db");
  const handle = openDatabase(databaseFilePath);

  try {
    assert.deepEqual(await handle.db.all("select 1 as value"), [{ value: 1 }]);
    assert.ok((await stat(databaseFilePath)).isFile());
    assert.equal("client" in handle, false);
  } finally {
    handle.close();
    await rm(directory, { recursive: true, force: true });
  }
});
