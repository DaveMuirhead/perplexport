// Timing constants — tune these if you hit Cloudflare challenges or rate limits

/** Pause between exporting individual threads (ms).
 *  Too fast → Cloudflare challenges; too slow → long export time.
 *  500ms has been observed to trigger Cloudflare after ~55 threads. */
export const THREAD_EXPORT_DELAY_MS = 1200;

/** Pause between fetching thread lists for consecutive spaces (ms).
 *  Perplexity rate-limits rapid list requests. */
export const SPACE_REQUEST_DELAY_MS = 800;

/** Base wait time when a Cloudflare challenge is detected (ms).
 *  Actual wait = CLOUDFLARE_BACKOFF_BASE_MS * (attempt + 1). */
export const CLOUDFLARE_BACKOFF_BASE_MS = 5000;

/** Base wait time when a RATE_LIMITED response is received (ms).
 *  Actual wait = RATE_LIMIT_BACKOFF_BASE_MS * (attempt + 1). */
export const RATE_LIMIT_BACKOFF_BASE_MS = 3000;

/** How many times to retry a thread fetch before giving up. */
export const THREAD_FETCH_RETRIES = 4;

/** How many times to retry a list API call before giving up. */
export const LIST_FETCH_RETRIES = 3;

/** Max threads per list API call.
 *  Note: /rest/thread/list_recent ignores this (and offset/cursor/page) and always
 *  returns at most 20 threads, which is why the library is enumerated over GraphQL
 *  instead — see src/listLibrary.ts. This limit still applies to the Space
 *  thread lists, which do honour it. */
export const LIST_LIMIT = 1000;

/** Max entries per thread page (server-side limit is 100). */
export const THREAD_PAGE_SIZE = 100;

/** How many files to download concurrently per thread.
 *  Kept low: the CDN is fine with it, but uploads carry a 10-minute
 *  pre-signed URL, so finishing a thread quickly matters more than raw speed. */
export const FILE_DOWNLOAD_CONCURRENCY = 4;

/** How many times to retry a single file download before giving up. */
export const FILE_DOWNLOAD_RETRIES = 3;

/** Base wait between file download retries (ms); multiplied by the attempt number. */
export const FILE_RETRY_BACKOFF_MS = 1000;

/** Give up on one file after this long (ms). Guards against a hung CDN connection. */
export const FILE_DOWNLOAD_TIMEOUT_MS = 120000;

/** Threads per page when walking the library via GraphQL.
 *  The server caps the first page at 25 regardless; later pages honour this. */
export const LIBRARY_PAGE_SIZE = 100;

/** Safety cap on library pages, so a cursor that stops advancing can't loop forever. */
export const LIBRARY_MAX_PAGES = 400;

/** Persisted-query hashes for the library listing.
 *
 *  Perplexity's web app sends GraphQL *persisted* queries: the query text lives
 *  server-side and the client references it by sha256. These hashes are tied to a
 *  frontend build and will eventually change — when they do, the server answers
 *  PersistedQueryNotFound and getConversations falls back to /rest/thread/list_recent
 *  (which returns only the 20 most recent threads).
 *
 *  To refresh: open the Library in a browser, scroll to trigger a second page, and
 *  copy operationName + extensions.persistedQuery.sha256Hash from the
 *  POST /rest/perplexity_ask/graphql requests. */
export const LIBRARY_FIRST_PAGE_QUERY = {
  operationName: "LibraryItemsRelayQuery",
  sha256Hash: "d7649c5560327f8b9dc7e69c7a59f00f4c323d0a592441ff1eac6f7e6b1d0bf9",
};

/** The *next* pages use a different operation and hash, with count/cursor
 *  variables instead of the first page's first/after. */
export const LIBRARY_NEXT_PAGE_QUERY = {
  operationName: "LibraryRecentItemsPaginationQuery",
  sha256Hash: "0306e8d9669f65a32f496ef70581533c6b5e327aef16b953004b9935f7d22c43",
};

/** Max memories per /rest/memories/list call. The endpoint defaults to 10 but
 *  honours a larger limit, and accounts hold tens of these, not thousands. */
export const MEMORY_LIST_LIMIT = 1000;

/** Page sizes for the Brain (knowledge context) query. Accounts hold tens of
 *  items, not thousands, so one request covers it; paging is followed anyway. */
export const BRAIN_KNOWLEDGE_PAGE_SIZE = 200;
export const BRAIN_MEMORIES_PAGE_SIZE = 100;

/** Safety cap on Brain pages, mirroring the library walk. */
export const BRAIN_MAX_PAGES = 50;

/** Persisted query behind /computer/memory ("Brain"). Like the library queries,
 *  this hash is pinned to a frontend build and will eventually rotate; when it
 *  does the server answers PersistedQueryNotFound and --brain reports that the
 *  hash needs refreshing. Capture a new one from the POST
 *  /rest/perplexity_ask/graphql request that page makes. */
export const BRAIN_QUERY = {
  operationName: "KnowledgeContextKnowledgeRelayQuery",
  sha256Hash: "2884580667156294c2dfab80de32b737ef7bdf1d2c765a1f37e45e0207afcc50",
};

/** Recorded in the export manifest so a backup says which build produced it.
 *  Kept in step with package.json's version. */
export const TOOL_VERSION = "2.1.0";

/** Page size for POST /rest/assets/search. The endpoint rejects anything
 *  above 40 with a 422, so this is a hard ceiling rather than a preference. */
export const ASSET_SEARCH_PAGE_SIZE = 40;

/** Safety cap on asset-library pages, mirroring the other paginated walks. */
export const ASSET_SEARCH_MAX_PAGES = 200;

/** Asset types the library can return. Sent verbatim as the `asset_type`
 *  filter — the web app passes the full list, and omitting it returns nothing. */
export const ASSET_SEARCH_TYPES = [
  "PDF_FILE",
  "DOCX_FILE",
  "XLSX_FILE",
  "RESEARCH_REPORT",
  "DOC_FILE",
  "GENERATED_IMAGE",
  "GENERATED_VIDEO",
  "APP",
  "VISUALIZATION",
  "SLIDES",
  "AUDIO_FILE",
  "MODEL_3D",
  "CHART",
  "CODE_FILE",
  "EXTERNAL_URL",
  "PULL_REQUEST",
].join(",");
