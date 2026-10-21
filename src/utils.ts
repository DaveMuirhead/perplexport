import { promises as fs } from "fs";

export interface DoneFile {
  processedUrls: string[];
}

export async function loadDoneFile(doneFilePath: string): Promise<DoneFile> {
  try {
    const content = await fs.readFile(doneFilePath, "utf-8");
    return JSON.parse(content);
  } catch (err: any) {
    if (err.code !== "ENOENT")
      console.error(`Warning: could not read ${doneFilePath}:`, err.message);
    return { processedUrls: [] };
  }
}

export async function saveDoneFile(doneFile: DoneFile, doneFilePath: string): Promise<void> {
  // Atomic write: temp file → rename, so a crash never produces a partial done.json
  const tmp = doneFilePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(doneFile, null, 2));
  await fs.rename(tmp, doneFilePath);
}

export async function writeAtomic(filePath: string, content: string): Promise<void> {
  // Skip the write when nothing changed, so an unchanged file keeps its mtime.
  // Downstream tooling keys off mtime — `npm run pdf` rebuilds a PDF whose .md
  // looks newer — and rewriting identical content on every sync made files that
  // are regenerated unconditionally (memories, Brain, the manifest) appear to
  // change on every run.
  try {
    if ((await fs.readFile(filePath, "utf-8")) === content) return;
  } catch {
    // Missing or unreadable: fall through and write it.
  }

  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, filePath);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
