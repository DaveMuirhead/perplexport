import { describe, it, expect, vi } from "vitest";
import type { Page } from "puppeteer";
import { fetchAssetLibrary, groupByContext, toLibraryAsset } from "../src/assetLibrary";

function raw(overrides: Record<string, unknown> = {}) {
  return {
    asset_id: "a1",
    location: "https://cdn.example.net/ctx/entry/Report.pdf?Policy=abc",
    asset_type: "PDF_FILE",
    delete_state: "ACTIVE",
    caption: "Quarterly Report – Acme",
    context_uuid: "ctx-1",
    entry_uuid: "e-1",
    ...overrides,
  };
}

function page(pages: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ limit: number; cursor: string | null }> = [];
  const p = {
    evaluate: vi.fn(async (_fn: unknown, _types: string, limit: number, cursor: string | null) => {
      calls.push({ limit, cursor });
      const next = pages.shift();
      if (!next) throw new Error("unexpected extra call");
      return {
        status: next.status ?? 200,
        body: typeof next.body === "string" ? next.body : JSON.stringify(next.body),
      };
    }),
  } as unknown as Page;
  return { p, calls };
}

describe("toLibraryAsset", () => {
  it("takes the filename from the URL, not the caption", () => {
    // caption is a display title with an en-dash; the file on disk is the slug.
    expect(toLibraryAsset(raw())?.filename).toBe("Report.pdf");
  });

  it("keeps the context uuid for thread attribution", () => {
    expect(toLibraryAsset(raw())).toMatchObject({ contextUuid: "ctx-1", entryUuid: "e-1" });
  });

  it("skips types that are not downloadable files", () => {
    // EXTERNAL_URL points at Google Docs, APP at a hosted site.
    expect(toLibraryAsset(raw({ asset_type: "EXTERNAL_URL" }))).toBeNull();
    expect(toLibraryAsset(raw({ asset_type: "APP" }))).toBeNull();
    expect(toLibraryAsset(raw({ asset_type: "PULL_REQUEST" }))).toBeNull();
  });

  it("skips deleted assets", () => {
    expect(toLibraryAsset(raw({ delete_state: "DELETED" }))).toBeNull();
  });

  it("skips rows with no id or no location", () => {
    expect(toLibraryAsset(raw({ asset_id: undefined }))).toBeNull();
    expect(toLibraryAsset(raw({ location: undefined }))).toBeNull();
    expect(toLibraryAsset(raw({ location: "https://cdn.example.net/" }))).toBeNull();
  });

  it("decodes percent-encoded filenames", () => {
    const asset = toLibraryAsset(raw({ location: "https://cdn.example.net/a/My%20Form.xlsx" }));
    expect(asset?.filename).toBe("My Form.xlsx");
  });
});

describe("fetchAssetLibrary", () => {
  it("requests the server's maximum page size", async () => {
    const { p, calls } = page([{ body: { entries: [{ asset: raw() }], next_cursor: null } }]);
    await fetchAssetLibrary(p);
    // The endpoint 422s above 40, so this is a ceiling rather than a preference.
    expect(calls[0].limit).toBe(40);
  });

  it("follows the cursor and dedupes by asset id", async () => {
    const { p, calls } = page([
      { body: { entries: [{ asset: raw({ asset_id: "a1" }) }], next_cursor: "C1" } },
      {
        body: {
          entries: [{ asset: raw({ asset_id: "a1" }) }, { asset: raw({ asset_id: "a2" }) }],
          next_cursor: null,
        },
      },
    ]);

    const assets = await fetchAssetLibrary(p);
    expect(assets.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(calls[1].cursor).toBe("C1");
  });

  it("stops when a page adds nothing new rather than looping", async () => {
    const same = () => ({
      body: { entries: [{ asset: raw({ asset_id: "a1" }) }], next_cursor: "SAME" },
    });
    const { p } = page([same(), same(), same()]);
    await expect(fetchAssetLibrary(p)).resolves.toHaveLength(1);
  });

  it("throws on a non-200 so the caller can warn", async () => {
    const { p } = page([{ status: 422, body: { detail: "limit too large" } }]);
    await expect(fetchAssetLibrary(p)).rejects.toThrow(/HTTP 422/);
  });

  it("tolerates empty or malformed rows", async () => {
    const { p } = page([
      { body: { entries: [null, { asset: null }, { asset: raw() }], next_cursor: null } },
    ]);
    await expect(fetchAssetLibrary(p)).resolves.toHaveLength(1);
  });
});

describe("groupByContext", () => {
  it("buckets assets by their context uuid", () => {
    const grouped = groupByContext([
      toLibraryAsset(raw({ asset_id: "a1", context_uuid: "ctx-1" }))!,
      toLibraryAsset(raw({ asset_id: "a2", context_uuid: "ctx-1" }))!,
      toLibraryAsset(raw({ asset_id: "a3", context_uuid: "ctx-2" }))!,
    ]);
    expect(grouped.get("ctx-1")).toHaveLength(2);
    expect(grouped.get("ctx-2")).toHaveLength(1);
  });

  it("ignores assets with no context", () => {
    const asset = toLibraryAsset(raw({ context_uuid: undefined }))!;
    expect(groupByContext([asset]).size).toBe(0);
  });
});
