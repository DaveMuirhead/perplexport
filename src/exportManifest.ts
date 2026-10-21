import { Page } from "puppeteer";
import { writeAtomic } from "./utils";

// A backup should say what it is: which account it came from, which
// organization, when it ran, with which options, and how much it captured.
// Without that, a directory of UUIDs is unattributable a year later — and an
// account that belongs to an org (where an admin may control retention) is
// exactly the case where provenance matters most.
//
// Identity comes from /api/auth/session, which backs the account panel at
// /computer/memory#settings/account. Note the /api/ prefix: the /rest/user/*
// endpoints expose only coarse flags (is_enterprise, is_student) and no email,
// username or id. Org details come from /rest/enterprise/user/organization,
// which backs /account/org/details and is absent for personal accounts.

export interface ManifestAccount {
  email?: string;
  username?: string;
  userId?: string;
  subscriptionTier?: string;
  subscriptionStatus?: string;
  orgRole?: string;
}

export interface ManifestOrganization {
  uuid?: string;
  displayName?: string;
  created?: string;
  ssoEnabled?: boolean;
  /** Org-controlled retention, in seconds. Null/absent means no limit.
   *  Worth recording: it explains why older threads may be missing. */
  threadRetentionSeconds?: number | null;
  memoryAllowed?: boolean;
  brainEnabled?: boolean;
}

export interface ManifestCounts {
  conversations: number;
  spaces: number;
  filesDownloaded?: number;
  filesMissingUpstream?: number;
  memories?: number;
  brainItems?: number;
}

export interface ExportManifest {
  exportedAt: string;
  tool: { name: string; version: string };
  options: Record<string, boolean>;
  account: ManifestAccount;
  organization?: ManifestOrganization;
  counts: ManifestCounts;
  /** Anything the run could not capture, so gaps are explicit rather than silent. */
  warnings?: string[];
}

async function getJson(page: Page, path: string): Promise<unknown | null> {
  // In-page fetch: these sit behind Cloudflare like every other API call here.
  const result = await page.evaluate(async (u: string) => {
    try {
      const r = await fetch(u);
      return { ok: r.ok, text: await r.text() };
    } catch {
      return { ok: false, text: "" };
    }
  }, path);

  if (!result.ok || !result.text || result.text.startsWith("<!DOCTYPE")) return null;
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export async function fetchAccount(page: Page): Promise<ManifestAccount> {
  const session = (await getJson(page, "/api/auth/session")) as {
    user?: Record<string, unknown>;
  } | null;
  const user = session?.user ?? {};
  return {
    email: str(user.email),
    username: str(user.username),
    userId: str(user.id),
    subscriptionTier: str(user.subscription_tier),
    subscriptionStatus: str(user.subscription_status),
    orgRole: str(user.org_role),
  };
}

export async function fetchOrganization(page: Page): Promise<ManifestOrganization | undefined> {
  const response = (await getJson(
    page,
    "/rest/enterprise/user/organization?supports_invite_link_state=true",
  )) as { organization?: Record<string, unknown> } | null;

  const org = response?.organization;
  if (!org) return undefined; // personal account

  const settings = (org.settings ?? {}) as Record<string, unknown>;
  return {
    uuid: str(org.uuid),
    displayName: str(org.display_name),
    created: str(org.created),
    ssoEnabled: typeof org.sso_enabled === "boolean" ? org.sso_enabled : undefined,
    threadRetentionSeconds:
      typeof settings.thread_retention_seconds === "number"
        ? settings.thread_retention_seconds
        : null,
    memoryAllowed:
      typeof settings.memory_allowed === "boolean" ? settings.memory_allowed : undefined,
    brainEnabled: typeof settings.brain_enabled === "boolean" ? settings.brain_enabled : undefined,
  };
}

export function renderManifest(manifest: ExportManifest): string {
  const lines = [
    "---",
    'title: "Perplexity export manifest"',
    "type: perplexity-export-manifest",
    `exported_at: ${manifest.exportedAt}`,
    "---",
    "",
    "# Perplexity export",
    "",
    `Exported **${manifest.exportedAt}** by ${manifest.tool.name} v${manifest.tool.version}.`,
    "",
    "## Account",
    "",
  ];

  const account: Array<[string, string | undefined]> = [
    ["Email", manifest.account.email],
    ["Username", manifest.account.username],
    ["User ID", manifest.account.userId],
    ["Subscription", manifest.account.subscriptionTier],
    ["Org role", manifest.account.orgRole],
  ];
  for (const [label, value] of account) {
    if (value) lines.push(`- **${label}:** ${value}`);
  }

  if (manifest.organization) {
    lines.push("", "## Organization", "");
    const org: Array<[string, string | undefined]> = [
      ["Name", manifest.organization.displayName],
      ["UUID", manifest.organization.uuid],
      ["Created", manifest.organization.created?.slice(0, 10)],
      ["SSO", manifest.organization.ssoEnabled ? "enabled" : undefined],
      [
        "Thread retention",
        manifest.organization.threadRetentionSeconds
          ? `${Math.round(manifest.organization.threadRetentionSeconds / 86400)} days`
          : "unlimited",
      ],
    ];
    for (const [label, value] of org) {
      if (value) lines.push(`- **${label}:** ${value}`);
    }
  }

  lines.push("", "## Contents", "");
  const counts: Array<[string, number | undefined]> = [
    ["Conversations", manifest.counts.conversations],
    ["Spaces", manifest.counts.spaces],
    ["Files downloaded", manifest.counts.filesDownloaded],
    ["Files no longer stored upstream", manifest.counts.filesMissingUpstream],
    ["Memories", manifest.counts.memories],
    ["Brain items", manifest.counts.brainItems],
  ];
  for (const [label, value] of counts) {
    if (value !== undefined) lines.push(`- **${label}:** ${value}`);
  }

  const enabled = Object.entries(manifest.options)
    .filter(([, on]) => on)
    .map(([name]) => `\`--${name}\``);
  lines.push(
    "",
    "## Options",
    "",
    enabled.length ? enabled.join(", ") : "none (conversations only)",
  );

  if (manifest.warnings?.length) {
    lines.push("", "## Warnings", "");
    for (const warning of manifest.warnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n") + "\n";
}

/** Write _manifest.md + _manifest.json describing this export. */
export async function writeManifest(outputDir: string, manifest: ExportManifest): Promise<void> {
  await writeAtomic(`${outputDir}/_manifest.json`, JSON.stringify(manifest, null, 2));
  await writeAtomic(`${outputDir}/_manifest.md`, renderManifest(manifest));
}
