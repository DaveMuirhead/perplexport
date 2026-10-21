import { WebResult } from "./types/conversation";

// Threads cite things that live outside the thread: Brain knowledge notes,
// personalization memories, earlier sessions, and uploaded/generated files.
// Once those are exported (--brain, --memories, --files) the citations can
// point at the local copies instead of naming a destination the reader can't
// reach.
//
// Resolution is best-effort and deliberately conservative: a citation only
// becomes a link when the target is known to exist on disk. Linking something
// that was never downloaded — an upload Perplexity has since pruned, a Brain
// item from an export that didn't use --brain — would trade a vague label for
// a broken link, which is worse.

export interface ContextIndex {
  /** Brain itemIds that were exported, e.g. "projects/career-transition". */
  brainItems?: Set<string>;
  /** Exported memories, keyed by memory_key. Their text is quoted inline
   *  rather than linked: each is a sentence or two, so the fact itself is
   *  more useful inline than a pointer into a 20-entry document. */
  memories?: Map<string, string>;
  /** Perplexity contextUUID → local thread uuid, for past-session citations. */
  threadByContextUuid?: Map<string, string>;
  /** Filenames successfully downloaded for the thread being rendered. */
  localFiles?: Set<string>;
  /** Thread uuid being rendered, so file links can be built. */
  threadUuid?: string;
  /** Path from a conversation file up to the output root ("" or "../"). */
  pathToRoot?: string;
}

/** The identifier a knowledge citation carries, normalised to a Brain itemId.
 *  Both forms appear: meta_data.path ("memory/knowledge/projects/x.md") and
 *  inline_entity_id ("knowledge:projects/x"). */
export function knowledgeItemId(result: WebResult): string | null {
  const meta = result.meta_data as { path?: unknown } | undefined;
  const path = typeof meta?.path === "string" ? meta.path : null;
  if (path) {
    return path.replace(/^memory\/knowledge\//, "").replace(/\.md$/, "") || null;
  }
  const entity = (result as { inline_entity_id?: unknown }).inline_entity_id;
  if (typeof entity === "string" && entity.startsWith("knowledge:")) {
    return entity.slice("knowledge:".length) || null;
  }
  return null;
}

/** The memory_key a memory citation refers to.
 *  Form is "memory:<key>:<uuid>" — the uuid identifies the stored instance,
 *  the key is what _memories.md records. */
export function memoryKey(result: WebResult): string | null {
  const entity = (result as { inline_entity_id?: unknown }).inline_entity_id;
  if (typeof entity !== "string") return null;
  const match = /^memory:([^:]+):/.exec(entity);
  return match ? match[1] : null;
}

/** The contextUUID an earlier-session citation refers to. This is NOT the
 *  thread uuid — it has to be mapped through the index. */
export function pastSessionContextUuid(result: WebResult): string | null {
  const entity = (result as { inline_entity_id?: unknown }).inline_entity_id;
  if (typeof entity !== "string") return null;
  const match = /^past_session:(.+)$/.exec(entity);
  return match ? match[1] : null;
}

/** The on-disk filename a file citation points at, if any. */
export function citedFilename(result: WebResult): string | null {
  if (!result.url || !/^https?:\/\//.test(result.url)) return null;
  try {
    const base = decodeURIComponent(new URL(result.url).pathname.split("/").pop() ?? "");
    return base || null;
  } catch {
    return null;
  }
}

function markdownLink(label: string, target: string, note?: string): string {
  const suffix = note ? ` (${note})` : "";
  return `[${label}](${encodeURI(target)})${suffix}`;
}

/** Render one cited source, linking it to local content when that content was
 *  exported. Returns the text after the leading "- ". */
export function renderCitation(result: WebResult, index: ContextIndex = {}): string {
  const root = index.pathToRoot ?? "";
  const name = result.name;

  // 1. A file the exporter downloaded for this thread. Only link when the file
  //    is actually on disk: most cited uploads are pruned upstream and were
  //    recorded as "gone", and a link to those would dangle.
  const filename = citedFilename(result);
  if (filename && index.localFiles?.has(filename) && index.threadUuid) {
    return markdownLink(name, `${root}_files/${index.threadUuid}/${filename}`, "local copy");
  }

  // 2. Plain web source.
  if (result.url?.startsWith("http")) {
    return `${markdownLink(name, result.url)} ${hostLabel(result.url)}`;
  }
  if (result.url) {
    return `${name} (${result.url})`;
  }

  // 3. Brain knowledge note.
  const itemId = knowledgeItemId(result);
  if (itemId && index.brainItems?.has(itemId)) {
    return markdownLink(name, `${root}_brain/${itemId}.md`, "Perplexity knowledge");
  }

  // 4. Personalization memory — quoted inline. These are short (a sentence or
  //    two), and the stated fact is more use to a reader than a pointer into
  //    _memories.md. Brain notes are linked instead: they run to thousands of
  //    characters and the same note is often cited several times in a thread.
  const key = memoryKey(result);
  const memoryText = key ? index.memories?.get(key) : undefined;
  if (key && memoryText) {
    const quoted = memoryText.trim().replace(/\s*\n\s*/g, " ");
    return `${name} (Perplexity memory: \`${key}\`)\n    > ${quoted}`;
  }

  // 5. An earlier conversation, if it was exported too.
  const contextUuid = pastSessionContextUuid(result);
  const threadUuid = contextUuid ? index.threadByContextUuid?.get(contextUuid) : undefined;
  if (threadUuid) {
    return `${markdownLink(name, `${root}${threadUuid}.md`)} (earlier session)`;
  }

  // 6. Nothing local to point at — name the kind so it doesn't read as a
  //    broken link.
  return `${name}${sourceKindLabel(result)}`;
}

/** Describe a source that has no URL and no local copy. */
export function sourceKindLabel(result: WebResult): string {
  const kind = (result.meta_data as { artifact_kind?: unknown } | undefined)?.artifact_kind;
  const label =
    kind === "memory"
      ? "Perplexity memory"
      : kind === "knowledge"
        ? "Perplexity knowledge"
        : kind === "past_session"
          ? "earlier session"
          : typeof kind === "string" && kind
            ? kind.replace(/_/g, " ")
            : "no link";
  return ` (${label})`;
}

export function hostLabel(url: string): string {
  try {
    return `(${new URL(url).hostname.replace("www.", "")})`;
  } catch {
    return "";
  }
}
