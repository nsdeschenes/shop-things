import { build } from "esbuild";
import { rm, writeFile } from "node:fs/promises";
const forbiddenInput = /(?:\/db\/|action-service|node:)/;
await Promise.all([
  rm("dist/preload.cjs", { force: true }),
  rm("dist/preload.meta.json", { force: true }),
]);
const result = await build({
  entryPoints: ["src/preload.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["electron"],
  outfile: "dist/preload.cjs",
  metafile: true,
  write: false,
});
const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports);
if (imports.some((entry) => !entry.external || entry.path !== "electron")) {
  throw new Error("Unexpected preload runtime dependency.");
}

if (Object.keys(result.metafile.inputs).some((path) => forbiddenInput.test(path))) {
  throw new Error("Backend code entered the preload bundle.");
}

for (const output of result.outputFiles) {
  await writeFile(output.path, output.contents);
}

await writeFile("dist/preload.meta.json", JSON.stringify(result.metafile, null, 2));
