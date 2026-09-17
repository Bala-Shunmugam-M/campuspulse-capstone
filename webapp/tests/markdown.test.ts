import { describe, expect, it } from "vitest";
import { markdownToPlainText, parseInline, parseMarkdown } from "../src/lib/markdown";

describe("the policy markdown subset", () => {
  it("parses headings, paragraphs and both kinds of list", () => {
    const blocks = parseMarkdown(
      [
        "## Scope",
        "",
        "This policy applies to every",
        "assessed submission.",
        "",
        "- One",
        "- Two",
        "",
        "1. First",
        "2. Second",
      ].join("\n"),
    );

    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "list"]);

    const [heading, paragraph, bullets, numbers] = blocks;
    expect(heading).toMatchObject({ kind: "heading", level: 2 });
    // Wrapped lines join into one paragraph, the way Markdown means them.
    expect(paragraph.kind === "paragraph" && paragraph.spans[0].text).toBe(
      "This policy applies to every assessed submission.",
    );
    expect(bullets).toMatchObject({ kind: "list", ordered: false });
    expect(numbers).toMatchObject({ kind: "list", ordered: true });
    expect(bullets.kind === "list" && bullets.items.length).toBe(2);
  });

  it("parses blockquotes and fenced code", () => {
    const blocks = parseMarkdown(
      ["> Behaviour online is behaviour.", "", "```", "  literal  text", "```"].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["quote", "code"]);
    expect(blocks[1]).toMatchObject({ kind: "code", text: "  literal  text" });
  });

  it("parses bold, italic and inline code", () => {
    const spans = parseInline("Plain **bold** and *italic* and `code`.");
    expect(spans.map((s) => s.kind)).toEqual([
      "text",
      "strong",
      "text",
      "em",
      "text",
      "code",
      "text",
    ]);
    expect(spans[1].text).toBe("bold");
    expect(spans[3].text).toBe("italic");
    expect(spans[5].text).toBe("code");
  });

  it("leaves markup inside backticks literal", () => {
    const spans = parseInline("Write `**stars**` to emphasise.");
    expect(spans.find((s) => s.kind === "code")?.text).toBe("**stars**");
    expect(spans.some((s) => s.kind === "strong")).toBe(false);
  });

  it("never produces markup from HTML in the source", () => {
    // The parser emits text, not tags. Whatever a policy body contains arrives
    // at the component as a string and is escaped by React on the way out.
    const blocks = parseMarkdown('<script>alert("x")</script>\n\n<b>bold?</b>');
    for (const block of blocks) {
      expect(block.kind).toBe("paragraph");
    }
    const text = markdownToPlainText('<script>alert("x")</script>');
    expect(text).toBe('<script>alert("x")</script>');
  });

  it("survives an empty body and trailing whitespace", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n   \n")).toEqual([]);
  });

  it("reduces a document to its plain text", () => {
    const text = markdownToPlainText("## Title\n\nSome **emphatic** words.\n\n- a\n- b");
    expect(text).toBe("Title Some emphatic words. a b");
  });
});
