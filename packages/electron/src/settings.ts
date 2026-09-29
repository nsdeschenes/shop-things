/* oxlint-disable import/no-named-export -- Backend APIs are consumed by IPC and packaged runners. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export interface DatabaseSettings {
  read(): Promise<string | null>;
  write(path: string): Promise<void>;
}

export class FileDatabaseSettings implements DatabaseSettings {
  constructor(private readonly settingsPath: string) {}

  async read(): Promise<string | null> {
    let text;
    try {
      text = await readFile(this.settingsPath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }

    const value: unknown = JSON.parse(text);
    if (
      typeof value !== "object" ||
      value === null ||
      !("path" in value) ||
      typeof value.path !== "string" ||
      !isAbsolute(value.path)
    ) {
      throw new Error("Remembered database settings are invalid");
    }

    return value.path;
  }

  async write(path: string): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ path }), { flag: "wx", mode: 0o600 });
      await rename(temporary, this.settingsPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
