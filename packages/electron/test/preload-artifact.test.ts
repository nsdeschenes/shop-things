import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
const externalElectron = /require\(["']electron["']\)/;
const forbiddenRuntime = /(?:node:|@shop-things\/db|drizzle|@tursodatabase|better-sqlite|sqlite3)/;
test("shipped sandbox preload is a single CommonJS bundle with only Electron external", async () => {
  const code = await readFile(new URL("../dist/preload.cjs", import.meta.url), "utf8");
  const meta: unknown = JSON.parse(
    await readFile(new URL("../dist/preload.meta.json", import.meta.url), "utf8"),
  );
  expect(code).toMatch(externalElectron);
  expect(code).toContain("exposeInMainWorld");
  expect(code).toContain("shopThings");
  expect(code).not.toMatch(forbiddenRuntime);
  expect(meta).toMatchObject({
    outputs: {
      "dist/preload.cjs": { imports: [{ path: "electron", kind: "require-call", external: true }] },
    },
  });
});
