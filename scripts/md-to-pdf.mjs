#!/usr/bin/env node
// Render each exported conversation's .md to a .pdf beside it.
//
//   node scripts/md-to-pdf.mjs [conversations-dir] [--force] [--only <substring>]
//
// Uses the Puppeteer Chrome this project already depends on, so there is no
// pandoc/LaTeX/wkhtmltopdf requirement. Chrome's print-to-PDF is also the one
// renderer guaranteed to agree with how the HTML looks.
//
// Skips files whose .pdf is newer than the .md unless --force is passed, so
// re-running after an incremental export only does the new work.
//
// Files under _files/ are downloaded attachments, not conversations, and are
// left alone — a .md attachment is someone's document, not an export.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import puppeteer from "puppeteer";

const root = process.argv[2]?.startsWith("--") ? "./conversations" : process.argv[2] ?? "./conversations";
const force = process.argv.includes("--force");
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];

/** Collect conversation .md files, skipping downloaded attachments. */
async function markdownFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_files") continue; // attachments, not conversations
      out.push(...(await markdownFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/** Split leading YAML frontmatter from the body. Values are read with a tiny
 *  line parser rather than a YAML dep: the exporter writes only flat
 *  `key: "value"` pairs (see renderConversation.ts). */
function splitFrontmatter(raw) {
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { meta: {}, body: raw };

  const meta = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    // Values are JSON-encoded strings when they may contain quotes.
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.replace(/^"|"$/g, "");
      }
    }
    meta[key] = value;
  }
  return { meta, body: raw.slice(end + 4).replace(/^\n+/, "") };
}

/** Normalise the Obsidian-flavoured markdown the exporter writes into plain
 *  CommonMark that reads correctly on paper. */
function normalise(body) {
  return (
    body
      // Obsidian block anchors (^1-2) are internal cross-reference markers;
      // they carry no meaning outside the vault and read as noise.
      .replace(/[ \t]*\^\d+-\d+(?=\s*$)/gm, "")
      // Inline citation refs the exporter rewrites to [[#^1-2]].
      .replace(/\[\[#\^\d+-\d+\]\]/g, "")
      // Callouts: >[!question] Prompt → a blockquote tagged for styling. The
      // marker line is dropped for prompts; the "Prompt" label carries it.
      .replace(/^>\s*\[!(\w+)\][ \t]*(.*)$/gim, (_m, kind, rest) => {
        const label = (rest || kind).trim();
        return `> <span class="callout-label callout-${kind.toLowerCase()}">${label}</span>`;
      })
      // Mark the answer heading so it can be styled as a quiet label.
      .replace(/^###[ \t]+Answer[ \t]*$/gim, '<h3 class="answer-label">Answer</h3>')
      // [[target|label]] / [[target]] wikilinks have no meaning in a PDF.
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
  );
}

const STYLE = `
  @page { size: Letter; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  body {
    font: 10.5pt/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a; margin: 0; overflow-wrap: break-word;
  }
  header.doc { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 22px; }
  header.doc h1 { font-size: 17pt; margin: 0 0 4px; line-height: 1.25; }
  header.doc .meta { font-size: 8.5pt; color: #666; }
  header.doc .meta span + span::before { content: " · "; }

  h1, h2, h3, h4 { line-height: 1.25; margin: 1.5em 0 0.5em; break-after: avoid; }
  h1 { font-size: 14pt; } h2 { font-size: 12pt; } h3 { font-size: 11pt; }
  h2 { border-bottom: 1px solid #ddd; padding-bottom: 3px; }
  p, li { orphans: 2; widows: 2; }
  a { color: #0b5cad; text-decoration: none; }

  /* Thread entries are separated by --- in the export. */
  hr { border: 0; border-top: 1px solid #ccc; margin: 26px 0; }

  /* Prompts: tinted block with a heavy rule, so a question is unmistakable
     against the plain prose of an answer. */
  blockquote {
    margin: 1.4em 0 1em; padding: 10px 14px;
    background: #eef3fb; border-left: 4px solid #2f6fb5;
    break-inside: avoid;
  }
  blockquote p { margin: 0.35em 0; }
  blockquote p:first-of-type { margin-top: 0; }
  blockquote p:last-of-type { margin-bottom: 0; }
  .callout-label {
    display: block; font-size: 7.5pt; font-weight: 700;
    letter-spacing: .09em; text-transform: uppercase;
    color: #2f6fb5; margin-bottom: 4px;
  }
  .callout-important { color: #8a6100; }
  blockquote:has(.callout-important) { background: #fdf6e7; border-left-color: #c79100; }

  /* Answer label: quiet, but enough to anchor where the reply starts. */
  h3.answer-label {
    font-size: 7.5pt; font-weight: 700; letter-spacing: .09em;
    text-transform: uppercase; color: #888;
    margin: 1.1em 0 .5em; border: 0; padding: 0;
  }

  code { font: 9.5pt/1.4 ui-monospace, Menlo, Consolas, monospace; background: #f2f2f2;
         padding: 1px 4px; border-radius: 3px; }
  pre { background: #f6f8fa; padding: 10px 12px; border-radius: 4px; overflow-x: auto; }
  pre code { background: none; padding: 0; }

  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 9.5pt; }
  th, td { border: 1px solid #ccc; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #f2f4f6; }
  tr { break-inside: avoid; }

  img { max-width: 100%; }
  ul, ol { padding-left: 1.4em; }
  li { margin: 0.2em 0; }
`;

function buildHtml(meta, bodyHtml) {
  const title = meta.title || "Perplexity conversation";
  const date = (meta.created_at || "").slice(0, 10);
  const updated = (meta.updated_at || "").slice(0, 10);

  const bits = [];
  if (date) bits.push(`<span>${date}</span>`);
  if (updated && updated !== date) bits.push(`<span>updated ${updated}</span>`);
  if (meta.collection) bits.push(`<span>${escapeHtml(meta.collection)}</span>`);

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><header class="doc"><h1>${escapeHtml(title)}</h1>
${bits.length ? `<div class="meta">${bits.join("")}</div>` : ""}</header>
${bodyHtml}</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** True when the .pdf is already newer than its .md. */
async function upToDate(mdPath, pdfPath) {
  try {
    const [md, pdf] = await Promise.all([fs.stat(mdPath), fs.stat(pdfPath)]);
    return pdf.mtimeMs >= md.mtimeMs && pdf.size > 0;
  } catch {
    return false;
  }
}

const files = (await markdownFiles(root)).filter((f) => !only || f.includes(only)).sort();
if (files.length === 0) {
  console.error(`No .md files found under ${root}`);
  process.exit(1);
}

marked.setOptions({ gfm: true, breaks: false });

const browser = await puppeteer.launch({ headless: true });
let written = 0;
let skipped = 0;
let failed = 0;

try {
  const page = await browser.newPage();

  for (const mdPath of files) {
    const pdfPath = mdPath.replace(/\.md$/, ".pdf");
    const label = path.relative(root, mdPath);

    if (!force && (await upToDate(mdPath, pdfPath))) {
      skipped++;
      continue;
    }

    try {
      const raw = await fs.readFile(mdPath, "utf8");
      const { meta, body } = splitFrontmatter(raw);
      const html = buildHtml(meta, marked.parse(normalise(body)));

      // setContent + print is enough; nothing here loads remote resources.
      await page.setContent(html, { waitUntil: "load" });
      await page.pdf({
        path: pdfPath,
        format: "letter",
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: "<div></div>",
        footerTemplate:
          '<div style="width:100%;font:8pt -apple-system,Arial,sans-serif;color:#888;' +
          'padding:0 16mm;display:flex;justify-content:flex-end;">' +
          '<span class="pageNumber"></span>/<span class="totalPages"></span></div>',
        margin: { top: "18mm", bottom: "20mm", left: "16mm", right: "16mm" },
      });

      const { size } = await fs.stat(pdfPath);
      console.log(`  ok   ${label}  (${(size / 1024).toFixed(0)} KB)`);
      written++;
    } catch (err) {
      console.log(`  FAIL ${label}  ${err.message}`);
      failed++;
    }
  }
} finally {
  await browser.close();
}

console.log(
  `\n${written} written, ${skipped} already up to date, ${failed} failed` +
    (skipped && !force ? " (use --force to rebuild all)" : ""),
);
if (failed > 0) process.exitCode = 1;
