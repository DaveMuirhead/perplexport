import { describe, it, expect, vi } from "vitest";
import type { Page } from "puppeteer";
import {
  BrainQueryUnavailable,
  fetchBrainItems,
  itemPath,
  renderBrainIndex,
  renderBrainItem,
  type BrainItem,
} from "../src/exportBrain";

function item(overrides: Partial<BrainItem> = {}): BrainItem {
  return {
    itemId: "projects/career-transition",
    name: "Career Transition",
    groupId: "projects",
    semanticType: "project",
    updatedAt: "2026-10-20T00:39:00Z",
    text: "# Career Transition\n\nSome notes.",
    truncated: false,
    links: [],
    ...overrides,
  };
}

/** Build one page of the knowledge connection. */
function connection(nodes: unknown[], pageInfo = { hasNextPage: false, endCursor: null }) {
  return JSON.stringify({
    data: {
      viewer: {
        knowledgeContext: {
          scopeByKind: {
            knowledgeCategories: [{ items: { edges: nodes.map((node) => ({ node })), pageInfo } }],
          },
        },
      },
    },
  });
}

function fakePage(pages: Array<{ status?: number; body: string }>) {
  const calls: Array<Record<string, unknown>> = [];
  const page = {
    evaluate: vi.fn(
      async (_fn: unknown, _op: string, _hash: string, vars: Record<string, unknown>) => {
        calls.push(vars);
        const next = pages.shift();
        if (!next) throw new Error("unexpected extra GraphQL call");
        return { status: next.status ?? 200, body: next.body };
      },
    ),
  } as unknown as Page;
  return { page, calls };
}

describe("fetchBrainItems", () => {
  it("requests full content, not just the previews the page asks for", async () => {
    const { page, calls } = fakePage([
      { body: connection([{ itemId: "a/b", name: "AB", content: { text: "body" } }]) },
    ]);

    await fetchBrainItems(page);

    // The UI sends includeContent:false; the markdown only comes back with true.
    expect(calls[0].includeContent).toBe(true);
  });

  it("maps content, links and metadata", async () => {
    const { page } = fakePage([
      {
        body: connection([
          {
            itemId: "concepts/aac",
            name: "AAC",
            groupId: "concepts",
            semanticType: "concept",
            updatedAt: "2026-10-20T00:39:00Z",
            content: { text: "# AAC", truncated: false },
            outboundLinks: [{ kind: "KNOWLEDGE", targetItemId: "entities/x", rawText: "entities/x" }],
          },
        ]),
      },
    ]);

    const [parsed] = await fetchBrainItems(page);
    expect(parsed).toMatchObject({
      itemId: "concepts/aac",
      name: "AAC",
      groupId: "concepts",
      text: "# AAC",
      truncated: false,
    });
    expect(parsed.links).toHaveLength(1);
  });

  it("falls back to the preview and flags truncation when content is withheld", async () => {
    const { page } = fakePage([
      { body: connection([{ itemId: "a/b", name: "AB", preview: "just a preview" }]) },
    ]);

    const [parsed] = await fetchBrainItems(page);
    expect(parsed.text).toBe("just a preview");
    expect(parsed.truncated).toBe(true);
  });

  it("follows the cursor and dedupes across pages", async () => {
    const { page } = fakePage([
      {
        body: connection([{ itemId: "a/1", name: "One", content: { text: "1" } }], {
          hasNextPage: true,
          endCursor: "C1",
        }),
      },
      {
        body: connection([
          { itemId: "a/1", name: "One", content: { text: "1" } },
          { itemId: "a/2", name: "Two", content: { text: "2" } },
        ]),
      },
    ]);

    const items = await fetchBrainItems(page);
    expect(items.map((i) => i.itemId)).toEqual(["a/1", "a/2"]);
  });

  it("stops rather than looping when a page adds nothing new", async () => {
    const repeated = () => ({
      body: connection([{ itemId: "a/1", name: "One", content: { text: "1" } }], {
        hasNextPage: true,
        endCursor: "SAME",
      }),
    });
    const { page } = fakePage([repeated(), repeated(), repeated()]);

    const items = await fetchBrainItems(page);
    expect(items).toHaveLength(1);
  });

  it("flags a rotated persisted query", async () => {
    const { page } = fakePage([
      { status: 400, body: JSON.stringify({ errors: [{ message: "PersistedQueryNotFound" }] }) },
    ]);
    await expect(fetchBrainItems(page)).rejects.toThrow(BrainQueryUnavailable);
  });

  it("surfaces GraphQL errors returned with HTTP 200", async () => {
    const { page } = fakePage([{ body: JSON.stringify({ errors: [{ message: "denied" }] }) }]);
    await expect(fetchBrainItems(page)).rejects.toThrow(/denied/);
  });
});

describe("itemPath", () => {
  it("mirrors the itemId as <group>/<name>.md", () => {
    expect(itemPath(item({ itemId: "projects/career-transition" }))).toBe(
      "projects/career-transition.md",
    );
  });

  it("handles an itemId with no group", () => {
    expect(itemPath(item({ itemId: "loose" }))).toBe("loose.md");
  });

  it("cannot escape the output directory", () => {
    const path = itemPath(item({ itemId: "../../etc/passwd" }));
    expect(path).not.toContain("..");
    expect(path.split("/").length).toBeLessThanOrEqual(2);
  });
});

describe("renderBrainItem", () => {
  it("keeps the item's own markdown under a frontmatter header", () => {
    const out = renderBrainItem(item({ text: "# Heading\n\nBody text." }));
    expect(out).toContain('title: "Career Transition"');
    expect(out).toContain('item_id: "projects/career-transition"');
    expect(out).toContain("# Heading");
    expect(out).toContain("Body text.");
  });

  it("lists outbound links", () => {
    const out = renderBrainItem(
      item({ links: [{ targetItemId: "entities/x" }, { targetItemId: "entities/x" }] }),
    );
    expect(out).toContain("## Linked");
    // deduped
    expect(out.match(/entities\/x/g)).toHaveLength(1);
  });

  it("records when content came back truncated", () => {
    expect(renderBrainItem(item({ truncated: true }))).toContain("content_truncated: true");
    expect(renderBrainItem(item({ truncated: false }))).not.toContain("content_truncated");
  });
});

describe("renderBrainIndex", () => {
  it("groups items and links to their files", () => {
    const out = renderBrainIndex([
      item({ itemId: "projects/a", name: "A", groupId: "projects" }),
      item({ itemId: "entities/b", name: "B", groupId: "entities" }),
    ]);
    expect(out).toContain("count: 2");
    expect(out).toContain("## projects");
    expect(out).toContain("## entities");
    expect(out).toContain("[A](projects/a.md)");
    expect(out).toContain("[B](entities/b.md)");
  });

  it("handles an empty Brain", () => {
    expect(renderBrainIndex([])).toContain("No Brain items stored.");
  });
});
