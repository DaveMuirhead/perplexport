import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { writeAtomic } from "../src/utils";

describe("writeAtomic", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "perplexport-utils-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes a new file", async () => {
    const file = path.join(dir, "a.md");
    await writeAtomic(file, "hello");
    expect(await fs.readFile(file, "utf-8")).toBe("hello");
  });

  it("overwrites when the content differs", async () => {
    const file = path.join(dir, "a.md");
    await writeAtomic(file, "one");
    await writeAtomic(file, "two");
    expect(await fs.readFile(file, "utf-8")).toBe("two");
  });

  it("leaves mtime untouched when the content is identical", async () => {
    // `npm run pdf` rebuilds any PDF whose .md looks newer, so an unchanged
    // file must not appear modified just because a sync rewrote it.
    const file = path.join(dir, "a.md");
    await writeAtomic(file, "same");
    const before = (await fs.stat(file)).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    await writeAtomic(file, "same");

    expect((await fs.stat(file)).mtimeMs).toBe(before);
  });

  it("leaves no .tmp file behind", async () => {
    const file = path.join(dir, "a.md");
    await writeAtomic(file, "x");
    await writeAtomic(file, "x");
    expect(await fs.readdir(dir)).toEqual(["a.md"]);
  });
});
