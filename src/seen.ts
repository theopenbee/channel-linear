import { appendFile, copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SEEN_ISSUES_FILE = "seen_issues.ndjson";
export const SEEN_COMMENTS_FILE = "seen_comments.ndjson";

export function legacyStateDir(): string {
  return join(homedir(), ".openbee", ".linear");
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function importLegacy(dataDir: string, legacyDir: string, file: string): Promise<boolean> {
  const target = join(dataDir, file);
  try {
    await readFile(target);
    return false;
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await copyFile(join(legacyDir, file), target);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

export class SeenSet {
  private readonly ids = new Set<string>();
  private partialTail = false;

  constructor(
    private readonly dir: string,
    private readonly file: string,
  ) {}

  get size(): number {
    return this.ids.size;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(join(this.dir, this.file), "utf8");
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    const lines = text.split("\n");
    if (!text.endsWith("\n")) {
      this.partialTail = lines.pop() !== "";
    }
    for (const line of lines) if (line) this.ids.add(line);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  async add(ids: string[]): Promise<void> {
    const fresh = [...new Set(ids)].filter((id) => !this.ids.has(id));
    if (fresh.length === 0) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lead = this.partialTail ? "\n" : "";
    await appendFile(join(this.dir, this.file), lead + fresh.map((id) => id + "\n").join(""), { mode: 0o600 });
    this.partialTail = false;
    for (const id of fresh) this.ids.add(id);
  }
}
