import { describe, it, expect, vi } from "vitest";
import type { Page } from "puppeteer";
import { fetchMemories, renderMemories, type Memory } from "../src/exportMemories";

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    memory_key: "work.role",
    display_key: "work.role",
    display_key_pretty: "Work",
    display_value: "The user is a clinical director.",
    updated_at: "2026-10-19T20:00:59+00:00",
    ...overrides,
  };
}

describe("renderMemories", () => {
  it("writes frontmatter with the count", () => {
    const out = renderMemories([memory(), memory({ memory_key: "work.other" })]);
    expect(out).toContain('title: "Perplexity memories"');
    expect(out).toContain("type: perplexity-memories");
    expect(out).toContain("count: 2");
  });

  it("groups entries under their pretty category", () => {
    const out = renderMemories([
      memory({ memory_key: "a", display_key_pretty: "Work", display_value: "Works here." }),
      memory({ memory_key: "b", display_key_pretty: "Education", display_value: "Studied there." }),
      memory({ memory_key: "c", display_key_pretty: "Work", display_value: "Also this." }),
    ]);

    expect(out).toContain("## Work");
    expect(out).toContain("## Education");
    // one heading per group, not one per memory
    expect(out.match(/^## Work$/gm)).toHaveLength(1);
    expect(out).toContain("Works here.");
    expect(out).toContain("Also this.");
  });

  it("records each memory's key and date", () => {
    const out = renderMemories([memory({ memory_key: "writing.tone" })]);
    expect(out).toContain("`writing.tone`");
    expect(out).toContain("updated 2026-10-19");
  });

  it("falls back to the raw key when there is no pretty name", () => {
    const out = renderMemories([
      memory({ display_key_pretty: undefined, display_key: "raw.key" }),
    ]);
    expect(out).toContain("## raw.key");
  });

  it("groups under Other when no key is usable", () => {
    const out = renderMemories([
      memory({ display_key_pretty: undefined, display_key: undefined }),
    ]);
    expect(out).toContain("## Other");
  });

  it("handles an account with no memories", () => {
    const out = renderMemories([]);
    expect(out).toContain("count: 0");
    expect(out).toContain("No memories stored.");
  });

  it("omits the date line when updated_at is absent", () => {
    const out = renderMemories([memory({ updated_at: undefined })]);
    expect(out).not.toContain("updated ");
    expect(out).toContain("`work.role`");
  });
});

describe("fetchMemories", () => {
  function fakePage(body: string, ok = true, status = 200) {
    return {
      evaluate: vi.fn(async () => ({ ok, status, text: body })),
    } as unknown as Page;
  }

  it("returns the memories array", async () => {
    const page = fakePage(JSON.stringify({ memories: [memory()] }));
    await expect(fetchMemories(page)).resolves.toHaveLength(1);
  });

  it("returns an empty list when the account has none", async () => {
    const page = fakePage(JSON.stringify({}));
    await expect(fetchMemories(page)).resolves.toEqual([]);
  });

  it("throws on a non-ok response", async () => {
    const page = fakePage("nope", false, 403);
    await expect(fetchMemories(page)).rejects.toThrow(/HTTP 403/);
  });

  it("throws when Cloudflare serves an HTML challenge", async () => {
    const page = fakePage("<!DOCTYPE html><html>Just a moment…</html>");
    await expect(fetchMemories(page)).rejects.toThrow(/memories\/list failed/);
  });
});
