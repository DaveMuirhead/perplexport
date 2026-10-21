import { promises as fs } from "fs";
import * as path from "path";
import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { loadOrLogin } from "./login";
import { getConversations, Space, Conversation } from "./listConversations";
import { loadLatestThreadEntry, loadThread } from "./ConversationSaver";
import { ConversationResponse } from "./types/conversation";
import renderConversation from "./renderConversation";
import { fetchThreadFiles, FetchFilesResult } from "./fetchAttachments";
import { exportMemories } from "./exportMemories";
import { exportBrain } from "./exportBrain";
import { ContextIndex } from "./linkContext";
import { loadDoneFile, saveDoneFile, writeAtomic, fileExists, sleep } from "./utils";
import { THREAD_EXPORT_DELAY_MS } from "./config";

export interface ExportLibraryOptions {
  outputDir: string;
  doneFilePath: string;
  email?: string;
  cookiesFile: string;
  otpFifo?: string;
  headful?: boolean;
  /** Download uploaded + generated files for each exported thread. */
  files?: boolean;
  /** Re-download files that already exist on disk. */
  refetchFiles?: boolean;
  /** Also export the account's stored personalization memories. */
  memories?: boolean;
  /** Also export the Brain knowledge store (/computer/memory). */
  brain?: boolean;
}

function sanitizeFolderName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function yamlStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderSpaceMd(space: Space, threads: Conversation[]): string {
  const fm = ["---", `title: ${yamlStr(space.title)}`, "type: perplexity-space"];
  if (space.description) fm.push(`description: ${yamlStr(space.description)}`);
  fm.push("---");

  const parts: string[] = [fm.join("\n")];

  if (space.instructions) {
    parts.push("## Instructions\n\n" + space.instructions);
  }

  if (threads.length > 0) {
    parts.push("## Chats\n\n" + threads.map((t) => `- [[${t.uuid}.md|${t.title}]]`).join("\n"));
  }

  return parts.join("\n\n") + "\n";
}

function conversationDir(outputDir: string, conversation: Conversation): string {
  if (!conversation.space) return outputDir;
  return `${outputDir}/${sanitizeFolderName(conversation.space.title)}`;
}

export interface LocalConversationState {
  latestEntryUuid?: string;
  latestUpdatedDatetime?: string;
}

export function readLocalConversationState(entries: unknown): LocalConversationState | undefined {
  if (!Array.isArray(entries)) return undefined;

  let latestUpdatedDatetime: string | undefined;
  for (const entry of entries) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "updated_datetime" in entry &&
      typeof entry.updated_datetime === "string" &&
      (!latestUpdatedDatetime || entry.updated_datetime > latestUpdatedDatetime)
    ) {
      latestUpdatedDatetime = entry.updated_datetime;
    }
  }

  const latestEntry = entries[entries.length - 1];
  const latestEntryUuid =
    typeof latestEntry === "object" &&
    latestEntry !== null &&
    "uuid" in latestEntry &&
    typeof latestEntry.uuid === "string"
      ? latestEntry.uuid
      : undefined;

  return { latestEntryUuid, latestUpdatedDatetime };
}

async function localConversationState(
  jsonPath: string,
): Promise<LocalConversationState | undefined> {
  try {
    const raw = await fs.readFile(jsonPath, "utf-8");
    const data = JSON.parse(raw) as { entries?: unknown };
    return readLocalConversationState(data.entries);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`Could not read local state from ${jsonPath}: ${(err as Error).message}`);
    }
    return undefined;
  }
}

async function needsSpaceRefresh(conversation: Conversation, jsonPath: string): Promise<boolean> {
  if (!conversation.space || !conversation.lastQueryDatetime) return false;

  const localState = await localConversationState(jsonPath);
  return (
    !localState?.latestUpdatedDatetime ||
    conversation.lastQueryDatetime > localState.latestUpdatedDatetime
  );
}

async function needsMainRefresh(
  page: Page,
  conversation: Conversation,
  jsonPath: string,
): Promise<boolean> {
  if (conversation.space) return false;

  const localState = await localConversationState(jsonPath);
  if (!localState?.latestEntryUuid) return true;

  const remoteLatestEntry = await loadLatestThreadEntry(page, conversation.uuid);
  return !remoteLatestEntry?.uuid || remoteLatestEntry.uuid !== localState.latestEntryUuid;
}

/** Rename an existing directory to <dir>.backup (or .backup.2, .backup.3, …).
 *  Called before any destructive re-export so no data is ever silently lost. */
async function backupIfExists(dir: string): Promise<void> {
  try {
    await fs.access(dir);
  } catch {
    return; // doesn't exist, nothing to back up
  }
  let dest = dir + ".backup";
  let n = 2;
  while (true) {
    try {
      await fs.access(dest);
      dest = `${dir}.backup.${n++}`;
    } catch {
      break;
    }
  }
  await fs.rename(dir, dest);
  console.log(`Backed up existing output to ${path.basename(dest)}`);
}

// puppeteer-extra has its own loose types; narrow launch() to the puppeteer Browser we use.
type Launcher = { launch: (options: { headless: boolean }) => Promise<Browser> };

// Headless Chrome is the easiest "tell" for Cloudflare Turnstile (seen on the 2FA page).
// Running headful under a virtual display (xvfb-run) often clears it.
async function launchBrowser(headful: boolean): Promise<Browser> {
  try {
    return await (puppeteer as unknown as Launcher).launch({ headless: !headful });
  } catch (err) {
    if ((err as Error).message?.includes("Could not find Chrome")) {
      throw new Error(
        "Chrome for Puppeteer is missing. Install it with: npx puppeteer browsers install chrome",
      );
    }
    throw err;
  }
}

// Zero conversations fetched while done.json already lists some means the session is no
// longer authenticated — Perplexity serves an empty library when logged out. Treat that
// as a hard error instead of a successful "nothing new" run.
export function isLikelyLoggedOut(fetchedCount: number, previouslyExportedCount: number): boolean {
  return fetchedCount === 0 && previouslyExportedCount > 0;
}

export default async function exportLibrary(options: ExportLibraryOptions) {
  puppeteer.use(StealthPlugin());

  await fs.mkdir(options.outputDir, { recursive: true });
  const doneFile = await loadDoneFile(options.doneFilePath);
  console.log(`${doneFile.processedUrls.length} already exported`);

  const browser = await launchBrowser(options.headful ?? false);

  try {
    const page = await loadOrLogin(browser, options.email, options.cookiesFile, options.otpFifo);
    const allConversations = await getConversations(page);

    if (isLikelyLoggedOut(allConversations.length, doneFile.processedUrls.length)) {
      throw new Error(
        `Fetched 0 conversations but ${doneFile.processedUrls.length} were previously exported — ` +
          "the saved session is almost certainly expired. Re-run with -e, --email <email> to refresh it.",
      );
    }

    // Memories are account-level, not per-thread: fetch once, before the loop.
    // A failure here must not cost the conversation export, so it is contained.
    if (options.memories) {
      try {
        const count = await exportMemories(page, options.outputDir);
        console.log(`Saved ${count} memories to _memories.md`);
      } catch (err) {
        console.warn(`Could not export memories: ${(err as Error).message}`);
      }
    }

    if (options.brain) {
      try {
        const count = await exportBrain(page, options.outputDir);
        console.log(`Saved ${count} Brain items to _brain/`);
      } catch (err) {
        console.warn(`Could not export Brain: ${(err as Error).message}`);
      }
    }

    // Index of exported context, so citations in a thread can link to the local
    // copies instead of naming a destination the reader can't reach. Only what
    // actually landed on disk goes in here — see linkContext.ts.
    const contextIndex: ContextIndex = {};
    try {
      const brainJson = `${options.outputDir}/_brain/_brain.json`;
      if (await fileExists(brainJson)) {
        const items = JSON.parse(await fs.readFile(brainJson, "utf-8")) as Array<{
          itemId?: string;
        }>;
        contextIndex.brainItems = new Set(
          items.map((i) => i.itemId).filter((v): v is string => typeof v === "string"),
        );
      }
      const memoriesJson = `${options.outputDir}/_memories.json`;
      if (await fileExists(memoriesJson)) {
        const memories = JSON.parse(await fs.readFile(memoriesJson, "utf-8")) as Array<{
          memory_key?: string;
          display_value?: string;
        }>;
        contextIndex.memories = new Map(
          memories
            .filter(
              (m): m is { memory_key: string; display_value: string } =>
                typeof m.memory_key === "string" && typeof m.display_value === "string",
            )
            .map((m) => [m.memory_key, m.display_value]),
        );
      }
    } catch (err) {
      console.warn(`Could not index exported context: ${(err as Error).message}`);
    }

    // Earlier-session citations use a contextUUID, not the thread uuid, so the
    // mapping is harvested from each thread as it is written.
    contextIndex.threadByContextUuid = new Map<string, string>();

    /** Filenames the exporter actually downloaded for a thread (status "ok").
     *  Cited uploads that Perplexity has pruned are recorded as "gone", and
     *  linking those would produce a dead link. */
    const localFilesFor = async (uuid: string): Promise<Set<string>> => {
      const manifestPath = `${filesRoot}/${uuid}/manifest.json`;
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
          files?: Array<{ filename?: string; status?: string }>;
        };
        return new Set(
          (manifest.files ?? [])
            .filter((f) => f.status === "ok" && typeof f.filename === "string")
            .map((f) => f.filename as string),
        );
      } catch {
        return new Set();
      }
    };

    /** contextUUIDs appearing in a thread, so later threads can link back. */
    const harvestContextUuids = (threadData: ConversationResponse, uuid: string) => {
      const seenHere = new Set<string>();
      const visit = (node: unknown): void => {
        if (typeof node === "string") {
          const trimmed = node.trim();
          if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 2) {
            try {
              visit(JSON.parse(trimmed));
            } catch {
              /* not JSON */
            }
          }
          return;
        }
        if (Array.isArray(node)) {
          node.forEach(visit);
          return;
        }
        if (node && typeof node === "object") {
          for (const [key, value] of Object.entries(node)) {
            if (
              (key === "context_uuid" || key === "contextUUID" || key === "backend_uuid") &&
              typeof value === "string"
            ) {
              seenHere.add(value);
            }
            visit(value);
          }
        }
      };
      visit(threadData.entries);
      for (const contextUuid of seenHere) {
        contextIndex.threadByContextUuid!.set(contextUuid, uuid);
      }
    };

    // Build space index and write _space.md files upfront with full thread lists
    const spaceMap = new Map<string, { space: Space; threads: Conversation[] }>();
    for (const c of allConversations) {
      if (!c.space) continue;
      if (!spaceMap.has(c.space.uuid)) {
        spaceMap.set(c.space.uuid, { space: c.space, threads: [] });
      }
      spaceMap.get(c.space.uuid)!.threads.push(c);
    }
    for (const { space, threads } of spaceMap.values()) {
      const dir = `${options.outputDir}/${sanitizeFolderName(space.title)}`;
      await fs.mkdir(dir, { recursive: true });
      await writeAtomic(`${dir}/_space.md`, renderSpaceMd(space, threads));
    }

    const processedUrls = new Set(doneFile.processedUrls);
    const todo: Array<{ conversation: Conversation; refreshExisting: boolean }> = [];
    let newCount = 0;
    let refreshCount = 0;

    for (const conversation of [...allConversations].reverse()) {
      const dir = conversationDir(options.outputDir, conversation);
      const jsonPath = `${dir}/${conversation.uuid}.json`;

      if (!processedUrls.has(conversation.url)) {
        todo.push({ conversation, refreshExisting: false });
        newCount++;
        continue;
      }

      if (await needsSpaceRefresh(conversation, jsonPath)) {
        todo.push({ conversation, refreshExisting: true });
        refreshCount++;
        continue;
      }

      if (await needsMainRefresh(page, conversation, jsonPath)) {
        todo.push({ conversation, refreshExisting: true });
        refreshCount++;
      }
    }

    console.log(`${newCount} new, ${refreshCount} updated conversations to export`);

    let exported = 0;
    let refreshed = 0;
    let skipped = 0;
    const fileTotals = { downloaded: 0, failed: 0, gone: 0, skipped: 0 };

    // Files live outside the thread folders so a Space rename can't orphan them,
    // and so the markdown/JSON tree stays exactly as it was before this feature.
    const filesRoot = `${options.outputDir}/_files`;

    // Conversation text is the primary artifact; files are a bonus. A file-side
    // failure must never abort the run or stop a thread being marked processed,
    // so everything here is contained and reported rather than thrown.
    const downloadFiles = async (conversation: Conversation, threadData: ConversationResponse) => {
      let result: FetchFilesResult;
      try {
        result = await fetchThreadFiles({
          page,
          uuid: conversation.uuid,
          conversation: threadData,
          filesDir: `${filesRoot}/${conversation.uuid}`,
          force: options.refetchFiles,
        });
      } catch (err) {
        console.warn(`    files: skipped — ${(err as Error).message}`);
        fileTotals.failed++;
        return;
      }
      fileTotals.downloaded += result.downloaded;
      fileTotals.failed += result.failed;
      fileTotals.gone += result.gone;
      fileTotals.skipped += result.skipped;

      const parts: string[] = [];
      if (result.downloaded) parts.push(`${result.downloaded} downloaded`);
      if (result.skipped) parts.push(`${result.skipped} already present`);
      if (result.gone) parts.push(`${result.gone} no longer stored upstream`);
      if (result.failed) parts.push(`${result.failed} failed`);
      if (parts.length) console.log(`    files: ${parts.join(", ")}`);
    };

    for (const { conversation, refreshExisting } of todo) {
      const dir = conversationDir(options.outputDir, conversation);

      const jsonPath = `${dir}/${conversation.uuid}.json`;
      const mdPath = `${dir}/${conversation.uuid}.md`;

      if (!refreshExisting && (await fileExists(jsonPath)) && (await fileExists(mdPath))) {
        if (!processedUrls.has(conversation.url)) {
          doneFile.processedUrls.push(conversation.url);
          processedUrls.add(conversation.url);
          await saveDoneFile(doneFile, options.doneFilePath);
        }
        skipped++;

        // The thread itself is unchanged, but its files may never have been
        // fetched (e.g. first run with --files over an existing export). The
        // uploaded-file URLs expire in ~10 minutes, so they have to be re-signed
        // by re-reading the thread rather than reused from the saved JSON.
        if (
          options.files &&
          !(await fileExists(`${filesRoot}/${conversation.uuid}/manifest.json`))
        ) {
          console.log(`Fetching files: ${conversation.title.substring(0, 60)}`);
          // Re-reading the thread can fail on its own (rate limit, Cloudflare);
          // downloadFiles handles everything past that point.
          try {
            const { conversation: threadData } = await loadThread(page, conversation.uuid);
            await downloadFiles(conversation, threadData);
          } catch (err) {
            console.warn(`    files: could not re-read thread — ${(err as Error).message}`);
            fileTotals.failed++;
          }
          await sleep(THREAD_EXPORT_DELAY_MS);
        }
        continue;
      }

      console.log(
        `${refreshExisting ? "Refreshing" : "Exporting"}: ${conversation.title.substring(0, 70)}`,
      );

      const { conversation: threadData } = await loadThread(page, conversation.uuid);

      harvestContextUuids(threadData, conversation.uuid);

      await writeAtomic(jsonPath, JSON.stringify(threadData, null, 2));
      await writeAtomic(
        mdPath,
        renderConversation(threadData, conversation.space?.title, {
          ...contextIndex,
          threadUuid: conversation.uuid,
          localFiles: await localFilesFor(conversation.uuid),
          // Space threads sit one directory deeper than _files/_brain/_memories.
          pathToRoot: conversation.space ? "../" : "",
        }),
      );

      if (options.files) await downloadFiles(conversation, threadData);

      if (!processedUrls.has(conversation.url)) {
        doneFile.processedUrls.push(conversation.url);
        processedUrls.add(conversation.url);
        await saveDoneFile(doneFile, options.doneFilePath);
      }

      if (refreshExisting) refreshed++;
      else exported++;
      await sleep(THREAD_EXPORT_DELAY_MS);
    }

    if (skipped > 0) console.log(`Skipped ${skipped} already-exported.`);
    console.log(`Done. Exported ${exported} new conversations, refreshed ${refreshed}.`);
    if (options.files) {
      console.log(
        `Files: ${fileTotals.downloaded} downloaded, ${fileTotals.skipped} already present, ` +
          `${fileTotals.gone} no longer stored upstream, ${fileTotals.failed} failed.`,
      );
    }
  } finally {
    await browser.close();
  }
}

export { backupIfExists };
