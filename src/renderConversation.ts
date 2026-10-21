import {
  ConversationResponse,
  ConversationEntry,
  EntryStep,
  FinalAnswer,
  WebResult,
} from "./types/conversation";

function parseFinalAnswer(entry: ConversationEntry): FinalAnswer | null {
  try {
    const steps: EntryStep[] = JSON.parse(entry.text);
    const final = steps.find((s) => s.step_type === "FINAL");
    if (!final?.content?.answer) return null;
    return JSON.parse(final.content.answer as string) as FinalAnswer;
  } catch {
    return null;
  }
}

export default function renderConversation(
  conversation: ConversationResponse,
  space?: string,
): string {
  const { entries } = conversation;
  if (entries.length === 0) return "";

  const rawTitle = entries[0].thread_title || entries[0].query_str;
  const title = rawTitle.split("\n")[0].trim().slice(0, 120);

  const fmLines = [`title: ${JSON.stringify(title)}`, `type: perplexity-thread`];
  if (space) fmLines.push(`collection: ${JSON.stringify(space)}`);
  fmLines.push(
    `created_at: ${entries[0].updated_datetime}`,
    `updated_at: ${entries[entries.length - 1].updated_datetime}`,
  );

  const items = [`---\n${fmLines.join("\n")}\n---`];

  entries.forEach((entry, entryIndex) => {
    if (entryIndex > 0) items.push("* * *");

    // The prompt is a callout rather than a heading + callout repeating the same
    // text: the duplication read as a bug, and a blockquote is what visually
    // separates "what was asked" from the answer prose that follows it.
    items.push(`>[!question] Prompt\n> ${entry.query_str.split("\n").join("\n> ")}`);

    const finalAnswer = parseFinalAnswer(entry);

    if (finalAnswer?.answer) {
      // Labelled so an answer can't be mistaken for a continuation of the prompt,
      // which matters most in long multi-turn threads.
      items.push(`### Answer\n\n${cleanupAnswer(finalAnswer.answer, entryIndex)}`);
    }

    if (finalAnswer?.web_results?.length) {
      items.push(renderSources(finalAnswer.web_results, entryIndex));
    }
  });

  return items.join("\n\n");
}

function cleanupAnswer(answer: string, entryIndex: number): string {
  return answer
    .replace(/\[(.*?)\]\(pplx:\/\/.*?\)/g, "$1")
    .replace(/\[(\d+)\]/g, (_, num) => ` [[#^${entryIndex + 1}-${num}]] `);
}

function renderSources(webResults: WebResult[], entryIndex: number): string {
  let text = `## ${webResults.length} Sources\n\n`;
  webResults.forEach((result, index) => {
    const citation = index + 1;
    if (result.url?.startsWith("http")) {
      text += `- [${result.name}](${result.url}) ${hostLabel(result.url)}`;
    } else if (result.url) {
      text += `- ${result.name} (${result.url})`;
    } else {
      // Not every cited source is a web page. Perplexity also cites its own
      // stored context — memory, knowledge notes, earlier sessions — and those
      // carry no URL at all. Naming the kind beats printing an empty "()",
      // which reads as a file that failed to download.
      text += `- ${result.name}${sourceKindLabel(result)}`;
    }
    if (result.snippet) text += `\n    ${result.snippet}`;
    text += ` ^${entryIndex + 1}-${citation}\n`;
  });
  return text;
}

/** Describe a URL-less source, e.g. " (Perplexity memory)". */
function sourceKindLabel(result: WebResult): string {
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

function hostLabel(url: string): string {
  try {
    return `(${new URL(url).hostname.replace("www.", "")})`;
  } catch {
    return "";
  }
}
