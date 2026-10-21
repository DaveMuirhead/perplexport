import { describe, it, expect } from "vitest";
import {
  citedFilename,
  knowledgeItemId,
  memoryKey,
  pastSessionContextUuid,
  renderCitation,
  type ContextIndex,
} from "../src/linkContext";
import type { WebResult } from "../src/types/conversation";

const knowledge = {
  name: "Projects · Career Transition",
  meta_data: { artifact_kind: "knowledge", path: "memory/knowledge/projects/career-transition.md" },
  inline_entity_id: "knowledge:projects/career-transition",
} as unknown as WebResult;

const memory = {
  name: "Work · Employer",
  meta_data: { artifact_kind: "memory" },
  inline_entity_id: "memory:work.employer:6d04f5a9-0b6d-432d-88aa-4aa799daa8ad",
} as unknown as WebResult;

const pastSession = {
  name: "Earlier chat",
  meta_data: { artifact_kind: "past_session" },
  inline_entity_id: "past_session:ctx-1",
} as unknown as WebResult;

describe("identifier extraction", () => {
  it("normalises a knowledge path to an itemId", () => {
    expect(knowledgeItemId(knowledge)).toBe("projects/career-transition");
  });

  it("falls back to inline_entity_id when there is no path", () => {
    const result = { inline_entity_id: "knowledge:entities/x" } as unknown as WebResult;
    expect(knowledgeItemId(result)).toBe("entities/x");
  });

  it("takes the key out of memory:<key>:<uuid>", () => {
    expect(memoryKey(memory)).toBe("work.employer");
  });

  it("takes the contextUUID out of a past_session id", () => {
    expect(pastSessionContextUuid(pastSession)).toBe("ctx-1");
  });

  it("reads the filename out of a signed file URL", () => {
    const result = {
      url: "https://s3.example.com/a/b/My%20Form.pdf?X-Amz-Signature=x",
    } as WebResult;
    expect(citedFilename(result)).toBe("My Form.pdf");
  });
});

describe("renderCitation", () => {
  it("links a web source with its host", () => {
    const out = renderCitation({ name: "MDN", url: "https://developer.mozilla.org/" } as WebResult);
    expect(out).toBe("[MDN](https://developer.mozilla.org/) (developer.mozilla.org)");
  });

  it("links a knowledge citation to its exported Brain file", () => {
    const index: ContextIndex = { brainItems: new Set(["projects/career-transition"]) };
    expect(renderCitation(knowledge, index)).toContain("(_brain/projects/career-transition.md)");
  });

  it("quotes a memory inline rather than linking it", () => {
    const index: ContextIndex = {
      memories: new Map([["work.employer", "The user works at Example Co."]]),
    };
    const out = renderCitation(memory, index);
    expect(out).toContain("`work.employer`");
    expect(out).toContain("> The user works at Example Co.");
    // short facts are more useful inline than as a pointer into _memories.md
    expect(out).not.toContain("](");
  });

  it("flattens newlines when quoting a memory", () => {
    const index: ContextIndex = { memories: new Map([["work.employer", "One.\n\nTwo."]]) };
    expect(renderCitation(memory, index)).toContain("> One. Two.");
  });

  it("links an earlier session to the exported thread", () => {
    const index: ContextIndex = { threadByContextUuid: new Map([["ctx-1", "thread-uuid"]]) };
    expect(renderCitation(pastSession, index)).toContain("(thread-uuid.md) (earlier session)");
  });

  it("links a cited file only when it is on disk", () => {
    const result = {
      name: "Form.pdf",
      url: "https://s3.example.com/a/Form.pdf?X-Amz-Signature=x",
    } as WebResult;

    const present = renderCitation(result, {
      localFiles: new Set(["Form.pdf"]),
      threadUuid: "t1",
    });
    expect(present).toContain("(_files/t1/Form.pdf) (local copy)");

    // Pruned upstream: must stay a plain web link, not a dead local link.
    const absent = renderCitation(result, { localFiles: new Set(), threadUuid: "t1" });
    expect(absent).not.toContain("_files/");
    expect(absent).toContain("https://s3.example.com");
  });

  it("walks up out of a Space folder when linking", () => {
    const index: ContextIndex = {
      brainItems: new Set(["projects/career-transition"]),
      pathToRoot: "../",
    };
    expect(renderCitation(knowledge, index)).toContain("(../_brain/projects/career-transition.md)");
  });

  it("falls back to a kind label when nothing was exported", () => {
    expect(renderCitation(knowledge)).toBe(
      "Projects · Career Transition (Perplexity knowledge)",
    );
    expect(renderCitation(memory)).toBe("Work · Employer (Perplexity memory)");
    expect(renderCitation(pastSession)).toBe("Earlier chat (earlier session)");
  });

  it("never emits an empty pair of parens", () => {
    const bare = { name: "Mystery" } as WebResult;
    expect(renderCitation(bare)).toBe("Mystery (no link)");
  });
});
