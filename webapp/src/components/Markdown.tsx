import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";

/**
 * Renders a policy body. Every value below reaches the DOM as a JSX child, which
 * React escapes; dangerouslySetInnerHTML appears nowhere in this file, and that
 * is the point. A policy body that contains "<script>" shows those characters.
 */

function Spans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((span, i) => {
        if (span.kind === "strong") return <strong key={i}>{span.text}</strong>;
        if (span.kind === "em") return <em key={i}>{span.text}</em>;
        if (span.kind === "code")
          return (
            <code key={i} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em]">
              {span.text}
            </code>
          );
        return <span key={i}>{span.text}</span>;
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading": {
      const className =
        block.level === 1
          ? "mt-6 text-xl font-semibold text-slate-900"
          : block.level === 2
            ? "mt-6 text-lg font-semibold text-slate-900"
            : "mt-4 text-base font-semibold text-slate-900";
      const Tag = (block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4") as "h2";
      return (
        <Tag className={className}>
          <Spans spans={block.spans} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="mt-3 text-sm leading-6 text-slate-800">
          <Spans spans={block.spans} />
        </p>
      );
    case "list":
      return block.ordered ? (
        <ol className="mt-3 list-decimal pl-6 text-sm leading-6 text-slate-800">
          {block.items.map((item, i) => (
            <li key={i}>
              <Spans spans={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="mt-3 list-disc pl-6 text-sm leading-6 text-slate-800">
          {block.items.map((item, i) => (
            <li key={i}>
              <Spans spans={item} />
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote className="mt-3 border-l-4 border-slate-300 pl-3 text-sm italic leading-6 text-slate-700">
          <Spans spans={block.spans} />
        </blockquote>
      );
    case "code":
      return (
        <pre className="mt-3 overflow-x-auto rounded border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-800">
          {block.text}
        </pre>
      );
  }
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}

/**
 * A ts_headline snippet. The query asked for [[HL]]…[[/HL]] rather than HTML
 * tags precisely so this can split on them and emit <mark> elements itself.
 */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[\[HL\]\]|\[\[\/HL\]\]/);
  return (
    <span>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-amber-200 text-slate-900">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}
