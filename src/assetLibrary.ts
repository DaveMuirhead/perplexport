import { Page } from "puppeteer";
import { DiscoveredFile } from "./types/conversation";
import { ASSET_SEARCH_MAX_PAGES, ASSET_SEARCH_PAGE_SIZE, ASSET_SEARCH_TYPES } from "./config";

// The account-wide asset library behind /computer/artifacts, reached via
// POST /rest/assets/search.
//
// This exists because /rest/thread/<uuid>/entry-metadata has an incomplete
// view: for one thread here it returned 57 assets while the library listed 5
// more for the same thread, each a standalone asset (version_count 1, no
// parent, no sibling sharing a root_asset_id) rather than a superseded
// revision. The library also surfaces assets belonging to threads the library
// listing never returns, so it reaches content no per-thread walk can.
//
// It is a *supplementary* source, not a replacement: entry-metadata is still
// what re-signs per-thread assets, and the two are merged by asset uuid.

/** Types that are not downloadable files, whatever their `location` says.
 *  EXTERNAL_URL points at Google Docs/Forms and APP at a hosted site. */
const NON_FILE_TYPES = new Set(["EXTERNAL_URL", "PULL_REQUEST", "APP"]);

interface RawAsset {
  asset_id?: string;
  location?: string;
  asset_type?: string;
  delete_state?: string;
  caption?: string;
  context_uuid?: string;
  entry_uuid?: string;
  root_asset_id?: string | null;
  created_at?: number;
  media_type?: string;
}

interface SearchResponse {
  entries?: Array<{ asset?: RawAsset | null } | null>;
  next_cursor?: string | null;
}

/** One asset from the library, with the thread it belongs to. */
export interface LibraryAsset extends DiscoveredFile {
  /** Perplexity contextUUID — maps to a thread uuid via the export's own index. */
  contextUuid?: string;
}

function filenameFromUrl(url: string): string | null {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return base || null;
  } catch {
    return null;
  }
}

export function toLibraryAsset(raw: RawAsset): LibraryAsset | null {
  if (!raw?.asset_id || !raw.location) return null;
  if (raw.delete_state && raw.delete_state !== "ACTIVE") return null;
  if (raw.asset_type && NON_FILE_TYPES.has(raw.asset_type)) return null;

  // The URL basename is the real filename; `caption` is a display title
  // ("Cover Letter – Acme") that does not match what lands on disk.
  const filename = filenameFromUrl(raw.location);
  if (!filename) return null;

  return {
    kind: "generated",
    id: raw.asset_id,
    filename,
    url: raw.location,
    assetType: raw.asset_type,
    entryUuid: raw.entry_uuid,
    contextUuid: raw.context_uuid,
  };
}

/** Walk the whole asset library. */
export async function fetchAssetLibrary(page: Page): Promise<LibraryAsset[]> {
  const assets: LibraryAsset[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;

  for (let pages = 0; pages < ASSET_SEARCH_MAX_PAGES; pages++) {
    // In-page POST: /rest/ sits behind Cloudflare, which binds cf_clearance to
    // the browser's TLS fingerprint. See fetchThread in ConversationSaver.ts.
    const result = await page.evaluate(
      async (types: string, limit: number, after: string | null) => {
        try {
          const r = await fetch("/rest/assets/search?version=2.18&source=default", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ asset_type: types, limit, cursor: after }),
          });
          return { status: r.status, body: await r.text() };
        } catch (e) {
          return { status: -1, body: String(e) };
        }
      },
      ASSET_SEARCH_TYPES,
      ASSET_SEARCH_PAGE_SIZE,
      cursor,
    );

    if (result.status !== 200) {
      throw new Error(`assets/search: HTTP ${result.status}`);
    }

    const parsed = JSON.parse(result.body) as SearchResponse;
    let added = 0;
    for (const entry of parsed.entries ?? []) {
      const asset = entry?.asset ? toLibraryAsset(entry.asset) : null;
      if (!asset || seen.has(asset.id)) continue;
      seen.add(asset.id);
      assets.push(asset);
      added++;
    }

    // Stop at the end, or when a page stops yielding anything new (a cursor
    // that has stopped advancing).
    if (!parsed.next_cursor || (parsed.entries ?? []).length === 0 || added === 0) break;
    cursor = parsed.next_cursor;
  }

  return assets;
}

/** Group library assets by the contextUUID of the thread they belong to. */
export function groupByContext(assets: LibraryAsset[]): Map<string, LibraryAsset[]> {
  const byContext = new Map<string, LibraryAsset[]>();
  for (const asset of assets) {
    if (!asset.contextUuid) continue;
    if (!byContext.has(asset.contextUuid)) byContext.set(asset.contextUuid, []);
    byContext.get(asset.contextUuid)!.push(asset);
  }
  return byContext;
}
