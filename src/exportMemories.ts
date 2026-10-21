import { Page } from "puppeteer";
import { writeAtomic } from "./utils";
import { MEMORY_LIST_LIMIT } from "./config";

// Perplexity's "memories" are the personalization facts it keeps about an
// account — the things shown at /account/personalize/memories, and what threads
// cite as "Perplexity memory" when they have no URL. They live only server-side
// (the thread JSON records that a memory was consulted, never its contents), so
// this is the only way to get them into a backup.

export interface Memory {
  memory_key: string;
  display_key?: string;
  display_key_pretty?: string;
  display_value: string;
  updated_at?: string;
  memory_source_conversations?: unknown[] | null;
}

interface MemoriesResponse {
  memories?: Memory[];
}

/** Fetch every stored memory.
 *
 *  The endpoint defaults to 10 but honours a larger `limit` (unlike
 *  /rest/thread/list_recent, which caps at 20 regardless), so one request with a
 *  high limit returns the lot. */
export async function fetchMemories(page: Page): Promise<Memory[]> {
  // In-page fetch: /rest/ sits behind Cloudflare, which binds cf_clearance to
  // the browser's TLS fingerprint. See fetchThread in ConversationSaver.ts.
  const result = await page.evaluate(async (u: string) => {
    try {
      const r = await fetch(u);
      return { ok: r.ok, status: r.status, text: await r.text() };
    } catch (e) {
      return { ok: false, status: -1, text: String(e) };
    }
  }, `/rest/memories/list?limit=${MEMORY_LIST_LIMIT}`);

  if (!result.ok || result.text.startsWith("<!DOCTYPE")) {
    throw new Error(`memories/list failed (HTTP ${result.status})`);
  }

  const parsed = JSON.parse(result.text) as MemoriesResponse;
  return parsed.memories ?? [];
}

/** Group memories under their pretty category ("Work", "Education", …), keeping
 *  each group's entries in the order the API returned them. */
export function renderMemories(memories: Memory[]): string {
  const frontmatter = [
    "---",
    'title: "Perplexity memories"',
    "type: perplexity-memories",
    `count: ${memories.length}`,
    "---",
  ].join("\n");

  if (memories.length === 0) {
    return `${frontmatter}\n\nNo memories stored.\n`;
  }

  const groups = new Map<string, Memory[]>();
  for (const memory of memories) {
    const group = memory.display_key_pretty || memory.display_key || "Other";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(memory);
  }

  const parts = [frontmatter];
  parts.push(
    "These are the personalization facts Perplexity stores about this account " +
      "(shown at /account/personalize/memories). Threads cite them as sources with " +
      "no link, because the content is only held server-side.",
  );

  for (const [group, entries] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lines = [`## ${group}`];
    for (const memory of entries) {
      lines.push("");
      lines.push(memory.display_value.trim());
      const meta: string[] = [`\`${memory.memory_key}\``];
      if (memory.updated_at) meta.push(`updated ${memory.updated_at.slice(0, 10)}`);
      lines.push(`<sub>${meta.join(" · ")}</sub>`);
    }
    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n") + "\n";
}

/** Write memories to _memories.md + _memories.json in the output directory.
 *  Returns how many were saved. */
export async function exportMemories(page: Page, outputDir: string): Promise<number> {
  const memories = await fetchMemories(page);

  await writeAtomic(`${outputDir}/_memories.json`, JSON.stringify(memories, null, 2));
  await writeAtomic(`${outputDir}/_memories.md`, renderMemories(memories));

  return memories.length;
}
