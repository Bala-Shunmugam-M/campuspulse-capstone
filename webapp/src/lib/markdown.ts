/**
 * A deliberately small Markdown subset for policy bodies.
 *
 * It parses to a structure rather than to an HTML string, so the page renders
 * it as JSX and there is no point at which raw markup could be injected --
 * dangerouslySetInnerHTML never appears, and a policy body containing
 * "<script>" renders as those characters. A policy body is authored text, not
 * trusted markup, and the difference matters because the people who author
 * policies are not the people who audit them.
 *
 * Not supported, on purpose: links, images, tables, inline HTML. A link in a
 * policy would need its scheme vetted, and a URL renders perfectly well as
 * text. Add them when a policy actually needs one.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; spans: Inline[] }
  | { kind: "paragraph"; spans: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; spans: Inline[] }
  | { kind: "code"; text: string };

/**
 * Inline spans, in one pass. Code first so that `**not bold**` inside backticks
 * stays literal -- a policy quoting its own markup is not an unreasonable thing
 * for a policy to do.
 */
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|__([^_]+)__|_([^_]+)_/g;

export function parseInline(source: string): Inline[] {
  const spans: Inline[] = [];
  let index = 0;

  for (const match of source.matchAll(INLINE)) {
    const at = match.index;
    if (at > index) spans.push({ kind: "text", text: source.slice(index, at) });

    const [, code, strongStar, emStar, strongUnder, emUnder] = match;
    if (code !== undefined) spans.push({ kind: "code", text: code });
    else if (strongStar !== undefined) spans.push({ kind: "strong", text: strongStar });
    else if (strongUnder !== undefined) spans.push({ kind: "strong", text: strongUnder });
    else if (emStar !== undefined) spans.push({ kind: "em", text: emStar });
    else if (emUnder !== undefined) spans.push({ kind: "em", text: emUnder });

    index = at + match[0].length;
  }

  if (index < source.length) spans.push({ kind: "text", text: source.slice(index) });
  return spans.length > 0 ? spans : [{ kind: "text", text: "" }];
}

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", spans: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({
      kind: "list",
      ordered: list.ordered,
      items: list.items.map((item) => parseInline(item)),
    });
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        spans: parseInline(heading[2].trim()),
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      blocks.push({ kind: "quote", spans: parseInline(quote[1]) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const text = (bullet ?? numbered)![1];
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(text);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

/** The text of a document with its markup removed, for previews and summaries. */
export function markdownToPlainText(source: string): string {
  return parseMarkdown(source)
    .flatMap((block) => {
      if (block.kind === "code") return [block.text];
      if (block.kind === "list") return block.items.map((item) => item.map((s) => s.text).join(""));
      return [block.spans.map((s) => s.text).join("")];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
