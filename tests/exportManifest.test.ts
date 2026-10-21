import { describe, it, expect, vi } from "vitest";
import type { Page } from "puppeteer";
import {
  fetchAccount,
  fetchOrganization,
  renderManifest,
  type ExportManifest,
} from "../src/exportManifest";

/** Page stub returning a body per requested URL. */
function fakePage(byUrl: Record<string, unknown>) {
  return {
    evaluate: vi.fn(async (_fn: unknown, url: string) => {
      const body = byUrl[url];
      if (body === undefined) return { ok: false, text: "" };
      return { ok: true, text: typeof body === "string" ? body : JSON.stringify(body) };
    }),
  } as unknown as Page;
}

const SESSION_URL = "/api/auth/session";
const ORG_URL = "/rest/enterprise/user/organization?supports_invite_link_state=true";

function manifest(overrides: Partial<ExportManifest> = {}): ExportManifest {
  return {
    exportedAt: "2026-10-20T22:00:00.000Z",
    tool: { name: "perplexport", version: "2.1.0" },
    options: { files: true, memories: false, brain: false },
    account: { email: "a@example.com", username: "dave", subscriptionTier: "pro" },
    counts: { conversations: 55, spaces: 1 },
    ...overrides,
  };
}

describe("fetchAccount", () => {
  it("reads identity from the session endpoint", async () => {
    const page = fakePage({
      [SESSION_URL]: {
        user: {
          email: "a@example.com",
          username: "dave",
          id: "u-1",
          subscription_tier: "enterprise",
          subscription_status: "active",
          org_role: "admin",
        },
      },
    });

    await expect(fetchAccount(page)).resolves.toEqual({
      email: "a@example.com",
      username: "dave",
      userId: "u-1",
      subscriptionTier: "enterprise",
      subscriptionStatus: "active",
      orgRole: "admin",
    });
  });

  it("returns empty fields rather than throwing when the session is unavailable", async () => {
    await expect(fetchAccount(fakePage({}))).resolves.toEqual({
      email: undefined,
      username: undefined,
      userId: undefined,
      subscriptionTier: undefined,
      subscriptionStatus: undefined,
      orgRole: undefined,
    });
  });

  it("ignores non-JSON (e.g. a Cloudflare interstitial)", async () => {
    const page = fakePage({ [SESSION_URL]: "<!DOCTYPE html><html>Just a moment…</html>" });
    await expect(fetchAccount(page)).resolves.toMatchObject({ email: undefined });
  });
});

describe("fetchOrganization", () => {
  it("reads org details and retention settings", async () => {
    const page = fakePage({
      [ORG_URL]: {
        organization: {
          uuid: "org-1",
          display_name: "BGC",
          created: "2025-01-02T00:00:00Z",
          sso_enabled: false,
          settings: { thread_retention_seconds: 2592000, memory_allowed: true, brain_enabled: true },
        },
      },
    });

    await expect(fetchOrganization(page)).resolves.toEqual({
      uuid: "org-1",
      displayName: "BGC",
      created: "2025-01-02T00:00:00Z",
      ssoEnabled: false,
      threadRetentionSeconds: 2592000,
      memoryAllowed: true,
      brainEnabled: true,
    });
  });

  it("is undefined for a personal account", async () => {
    await expect(fetchOrganization(fakePage({ [ORG_URL]: { status: "success" } }))).resolves.toBeUndefined();
    await expect(fetchOrganization(fakePage({}))).resolves.toBeUndefined();
  });
});

describe("renderManifest", () => {
  it("records when the export ran and which tool version made it", () => {
    const out = renderManifest(manifest());
    expect(out).toContain("exported_at: 2026-10-20T22:00:00.000Z");
    expect(out).toContain("perplexport v2.1.0");
  });

  it("lists account details that are present and omits those that are not", () => {
    const out = renderManifest(manifest({ account: { email: "a@example.com" } }));
    expect(out).toContain("**Email:** a@example.com");
    expect(out).not.toContain("**Username:**");
  });

  it("omits the organization section for a personal account", () => {
    expect(renderManifest(manifest())).not.toContain("## Organization");
  });

  it("renders retention in days, and says unlimited when unset", () => {
    const withLimit = renderManifest(
      manifest({ organization: { displayName: "BGC", threadRetentionSeconds: 2592000 } }),
    );
    expect(withLimit).toContain("**Thread retention:** 30 days");

    const noLimit = renderManifest(
      manifest({ organization: { displayName: "BGC", threadRetentionSeconds: null } }),
    );
    expect(noLimit).toContain("**Thread retention:** unlimited");
  });

  it("reports counts, including zero", () => {
    const out = renderManifest(
      manifest({ counts: { conversations: 55, spaces: 0, filesDownloaded: 143 } }),
    );
    expect(out).toContain("**Conversations:** 55");
    expect(out).toContain("**Spaces:** 0");
    expect(out).toContain("**Files downloaded:** 143");
    expect(out).not.toContain("**Memories:**");
  });

  it("names the flags used, or says none", () => {
    expect(renderManifest(manifest())).toContain("`--files`");
    expect(
      renderManifest(manifest({ options: { files: false, memories: false, brain: false } })),
    ).toContain("none (conversations only)");
  });

  it("surfaces warnings so gaps in the backup are explicit", () => {
    const out = renderManifest(manifest({ warnings: ["Could not export Brain: HTTP 500"] }));
    expect(out).toContain("## Warnings");
    expect(out).toContain("Could not export Brain: HTTP 500");
  });

  it("omits the warnings section when the run was clean", () => {
    expect(renderManifest(manifest())).not.toContain("## Warnings");
  });
});

describe("degraded exports", () => {
  it("records degradations as manifest warnings", () => {
    const out = renderManifest(
      manifest({
        warnings: [
          "The GraphQL library listing is unavailable, so only the 20 most recent threads could be listed.",
        ],
      }),
    );
    expect(out).toContain("## Warnings");
    expect(out).toContain("only the 20 most recent threads");
  });
});
