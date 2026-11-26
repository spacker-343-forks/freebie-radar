import { Fragment, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, FileText, Link2, MessageSquareText } from "lucide-react";
import { t } from "../lib/i18n.ts";
import { isSafeHttpUrl, looksLikeHtml, parseSnapshotSections } from "../lib/snapshot.ts";

const URL_IN_TEXT_RE = /(https?:\/\/[^\s<>()[\]"'，。；！？、]+)/gi;
const INLINE_TOKEN_RE =
  /(!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|https?:\/\/[^\s<>()[\]"'，。；！？、]+)/gi;
const DROPPED_HTML_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "meta",
  "link",
  "noscript",
  "svg",
]);

function cleanUrl(raw: string): string {
  return raw.trim().replace(/[)>.,;。，；\]】]+$/u, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function SnapshotImage({ src, alt = "" }: { src: string; alt?: string }) {
  const [broken, setBroken] = useState(false);
  const safeSrc = isSafeHttpUrl(src);
  if (!safeSrc || broken) return null;
  return (
    <a href={safeSrc} target="_blank" rel="noopener noreferrer" className="my-2.5 block max-w-full">
      <img
        src={safeSrc}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="max-h-[460px] max-w-full rounded-lg border border-ink-200 bg-surface object-contain"
      />
    </a>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const trimmed = code.replace(/^\n+|\n+$/g, "");
  if (!trimmed) return null;
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-ink-200 bg-canvas">
      <div className="flex items-center justify-end border-b border-ink-200/80 bg-surface-hover px-2.5 py-1">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(trimmed).catch(() => undefined);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-950"
        >
          {copied ? <Check size={11} className="text-deal" /> : <Copy size={11} />}
          {copied ? t("已复制") : t("复制代码")}
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-900">
        <code>{trimmed}</code>
      </pre>
    </div>
  );
}

function renderBareUrls(text: string, keyPrefix: string): ReactNode {
  const parts = text.split(URL_IN_TEXT_RE);
  if (parts.length === 1) return text;
  return parts.map((part, idx) => {
    if (!/^https?:\/\//i.test(part)) return <Fragment key={`${keyPrefix}-t-${idx}`}>{part}</Fragment>;
    const href = isSafeHttpUrl(cleanUrl(part));
    if (!href) return <Fragment key={`${keyPrefix}-t-${idx}`}>{part}</Fragment>;
    const host = hostOf(href);
    return (
      <a
        key={`${keyPrefix}-u-${idx}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded border border-ink-200 bg-surface px-1.5 py-0.5 align-baseline text-[12px] font-medium text-accent hover:bg-ink-100 [overflow-wrap:anywhere]"
      >
        <span className="truncate">{host || href}</span>
        <ExternalLink size={10} className="shrink-0" />
      </a>
    );
  });
}

function isEmptyHtmlParagraph(el: Element): boolean {
  const text = (el.textContent ?? "").replace(/\u00a0/g, " ").trim();
  if (text.length > 0) return false;
  if (el.querySelector("img, pre, code, table, a")) return false;
  return true;
}

function renderDomNode(node: Node, key: string, ctx: { inListItem?: boolean; inLink?: boolean } = {}): ReactNode {
  if (node.nodeType === 3) {
    const val = node.nodeValue ?? "";
    if (!val) return null;
    if (ctx.inLink) return val;
    return renderBareUrls(val, key);
  }
  if (node.nodeType !== 1) return null;

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROPPED_HTML_TAGS.has(tag)) return null;

  const renderChildren = (nextCtx = ctx) =>
    Array.from(el.childNodes).map((child, idx) => renderDomNode(child, `${key}-${idx}`, nextCtx));

  switch (tag) {
    case "h1":
      return (
        <h1 key={key} className="mt-5 mb-2.5 text-[17px] font-bold leading-snug text-ink-950 [overflow-wrap:anywhere]">
          {renderChildren()}
        </h1>
      );
    case "h2":
      return (
        <h2 key={key} className="mt-4 mb-2 text-[15.5px] font-bold leading-snug text-ink-950 [overflow-wrap:anywhere]">
          {renderChildren()}
        </h2>
      );
    case "h3":
      return (
        <h3 key={key} className="mt-3.5 mb-1.5 text-[14px] font-semibold leading-snug text-ink-950 [overflow-wrap:anywhere]">
          {renderChildren()}
        </h3>
      );
    case "h4":
    case "h5":
    case "h6":
      return (
        <h4 key={key} className="mt-3 mb-1 text-[13.5px] font-semibold text-ink-900 [overflow-wrap:anywhere]">
          {renderChildren()}
        </h4>
      );
    case "p": {
      if (isEmptyHtmlParagraph(el)) return null;
      return (
        <p
          key={key}
          className={
            (ctx.inListItem ? "my-0.5 " : "my-2.5 ") +
            "text-[13.5px] leading-[1.8] text-ink-800 [overflow-wrap:anywhere] break-words"
          }
        >
          {renderChildren()}
        </p>
      );
    }
    case "br":
      return <br key={key} />;
    case "hr":
      return <hr key={key} className="my-4 border-ink-200" />;
    case "strong":
    case "b":
      return (
        <strong key={key} className="font-semibold text-ink-950">
          {renderChildren()}
        </strong>
      );
    case "em":
    case "i":
      return (
        <em key={key} className="italic">
          {renderChildren()}
        </em>
      );
    case "del":
    case "s":
      return (
        <del key={key} className="line-through opacity-75">
          {renderChildren()}
        </del>
      );
    case "ul":
      return (
        <ul key={key} className="my-2.5 list-disc space-y-1.5 pl-5 text-[13.5px] leading-[1.75] text-ink-800">
          {renderChildren()}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} className="my-2.5 list-decimal space-y-1.5 pl-5 text-[13.5px] leading-[1.75] text-ink-800">
          {renderChildren()}
        </ol>
      );
    case "li":
      return (
        <li key={key} className="min-w-0 [overflow-wrap:anywhere] break-words">
          {renderChildren({ ...ctx, inListItem: true })}
        </li>
      );
    case "blockquote":
      return (
        <blockquote
          key={key}
          className="my-3 rounded-r-lg border-l-[3px] border-brand-border bg-brand-subtle/30 py-2 pr-3 pl-3.5 text-[13px] leading-[1.75] text-ink-700 [overflow-wrap:anywhere]"
        >
          {renderChildren()}
        </blockquote>
      );
    case "pre":
      return <CodeBlock key={key} code={el.textContent ?? ""} />;
    case "code":
      return (
        <code
          key={key}
          className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[12px] text-ink-900 [overflow-wrap:anywhere]"
        >
          {el.textContent ?? ""}
        </code>
      );
    case "img":
      return (
        <SnapshotImage
          key={key}
          src={el.getAttribute("src") ?? ""}
          alt={el.getAttribute("alt") ?? ""}
        />
      );
    case "a": {
      const href = isSafeHttpUrl(el.getAttribute("href"));
      if (!href) return <Fragment key={key}>{renderChildren()}</Fragment>;
      return (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent [overflow-wrap:anywhere]"
        >
          {renderChildren({ ...ctx, inLink: true })}
        </a>
      );
    }
    case "table":
      return (
        <div key={key} className="my-3 max-w-full overflow-x-auto rounded-lg border border-ink-200">
          <table className="min-w-full border-collapse text-left text-[12px] text-ink-800">
            {renderChildren()}
          </table>
        </div>
      );
    case "thead":
      return (
        <thead key={key} className="bg-surface-hover font-semibold text-ink-950">
          {renderChildren()}
        </thead>
      );
    case "tbody":
      return <tbody key={key}>{renderChildren()}</tbody>;
    case "tr":
      return (
        <tr key={key} className="border-b border-ink-200 last:border-b-0">
          {renderChildren()}
        </tr>
      );
    case "th":
      return (
        <th key={key} className="border-r border-ink-200 px-3 py-2 last:border-r-0">
          {renderChildren()}
        </th>
      );
    case "td":
      return (
        <td key={key} className="border-r border-ink-200 px-3 py-2 align-top last:border-r-0 [overflow-wrap:anywhere]">
          {renderChildren()}
        </td>
      );
    default:
      return <Fragment key={key}>{renderChildren()}</Fragment>;
  }
}

function HtmlBody({ html }: { html: string }) {
  if (typeof DOMParser === "undefined") {
    return (
      <div className="text-[13.5px] leading-[1.8] whitespace-pre-wrap text-ink-800 [overflow-wrap:anywhere]">
        {html.replace(/<[^>]+>/g, " ").trim()}
      </div>
    );
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      {Array.from(doc.body.childNodes).map((child, idx) => renderDomNode(child, `html-${idx}`))}
    </div>
  );
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode {
  const nodes: ReactNode[] = [];
  INLINE_TOKEN_RE.lastIndex = 0;
  let lastIndex = 0;
  let idx = 0;
  let m: RegExpExecArray | null;

  while ((m = INLINE_TOKEN_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      nodes.push(<Fragment key={`${keyPrefix}-s-${idx++}`}>{text.slice(lastIndex, m.index)}</Fragment>);
    }
    if (m[2] !== undefined && m[3] !== undefined) {
      nodes.push(<SnapshotImage key={`${keyPrefix}-img-${idx++}`} src={m[3]} alt={m[2]} />);
    } else if (m[4] !== undefined && m[5] !== undefined) {
      const href = isSafeHttpUrl(cleanUrl(m[5]));
      nodes.push(
        href ? (
          <a
            key={`${keyPrefix}-a-${idx++}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent [overflow-wrap:anywhere]"
          >
            {m[4]}
          </a>
        ) : (
          <Fragment key={`${keyPrefix}-at-${idx++}`}>{m[4]}</Fragment>
        ),
      );
    } else if (m[6] !== undefined) {
      nodes.push(
        <code
          key={`${keyPrefix}-c-${idx++}`}
          className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[12px] text-ink-900 [overflow-wrap:anywhere]"
        >
          {m[6]}
        </code>,
      );
    } else if (m[7] !== undefined) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${idx++}`} className="font-semibold text-ink-950">
          {m[7]}
        </strong>,
      );
    } else {
      const href = isSafeHttpUrl(cleanUrl(m[0]));
      if (href) {
        const host = hostOf(href);
        nodes.push(
          <a
            key={`${keyPrefix}-u-${idx++}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded border border-ink-200 bg-surface px-1.5 py-0.5 align-baseline text-[12px] font-medium text-accent hover:bg-ink-100"
          >
            <span className="truncate">{host || href}</span>
            <ExternalLink size={10} className="shrink-0" />
          </a>,
        );
      } else {
        nodes.push(<Fragment key={`${keyPrefix}-raw-${idx++}`}>{m[0]}</Fragment>);
      }
    }
    lastIndex = INLINE_TOKEN_RE.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(<Fragment key={`${keyPrefix}-end`}>{text.slice(lastIndex)}</Fragment>);
  }
  return nodes.length ? nodes : text;
}

function MarkdownBody({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(<CodeBlock key={`cb-${blocks.length}`} code={codeLines.join("\n")} />);
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const content = renderInlineMarkdown(headingMatch[2]!, `h-${blocks.length}`);
      if (level === 1) {
        blocks.push(
          <h1 key={`h-${blocks.length}`} className="mt-5 mb-2 text-[17px] font-bold leading-snug text-ink-950">
            {content}
          </h1>,
        );
      } else if (level === 2) {
        blocks.push(
          <h2 key={`h-${blocks.length}`} className="mt-4 mb-1.5 text-[15px] font-bold leading-snug text-ink-950">
            {content}
          </h2>,
        );
      } else {
        blocks.push(
          <h3 key={`h-${blocks.length}`} className="mt-3.5 mb-1 text-[14px] font-semibold leading-snug text-ink-950">
            {content}
          </h3>,
        );
      }
      i += 1;
      continue;
    }

    if (/^(?:---+|\*\*\*+)$/.test(trimmed)) {
      blocks.push(<hr key={`hr-${blocks.length}`} className="my-4 border-ink-200" />);
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote
          key={`bq-${blocks.length}`}
          className="my-3 rounded-r-lg border-l-[3px] border-brand-border bg-brand-subtle/30 py-2 pr-3 pl-3.5 text-[13px] leading-[1.75] text-ink-700 [overflow-wrap:anywhere]"
        >
          {quoteLines.map((ql, idx) => (
            <p key={idx} className="my-0.5">
              {renderInlineMarkdown(ql, `bq-${blocks.length}-${idx}`)}
            </p>
          ))}
        </blockquote>,
      );
      continue;
    }

    if (/^[-•*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-•*]\s+/.test(lines[i]!.trim())) {
        items.push(lines[i]!.trim().replace(/^[-•*]\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${blocks.length}`} className="my-2.5 list-disc space-y-1.5 pl-5 text-[13.5px] leading-[1.75] text-ink-800">
          {items.map((it, idx) => (
            <li key={idx} className="min-w-0 [overflow-wrap:anywhere] break-words">
              {renderInlineMarkdown(it, `ul-${blocks.length}-${idx}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+[.、)）]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.、)）]\s+/.test(lines[i]!.trim())) {
        items.push(lines[i]!.trim().replace(/^\d+[.、)）]\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ol key={`ol-${blocks.length}`} className="my-2.5 list-decimal space-y-1.5 pl-5 text-[13.5px] leading-[1.75] text-ink-800">
          {items.map((it, idx) => (
            <li key={idx} className="min-w-0 [overflow-wrap:anywhere] break-words">
              {renderInlineMarkdown(it, `ol-${blocks.length}-${idx}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.trim().startsWith("```") &&
      !/^(#{1,4})\s+/.test(lines[i]!.trim()) &&
      !lines[i]!.trim().startsWith(">") &&
      !/^[-•*]\s+/.test(lines[i]!.trim()) &&
      !/^\d+[.、)）]\s+/.test(lines[i]!.trim()) &&
      !/^(?:---+|\*\*\*+)$/.test(lines[i]!.trim())
    ) {
      paraLines.push(lines[i]!.trim());
      i += 1;
    }
    blocks.push(
      <p key={`p-${blocks.length}`} className="my-2.5 text-[13.5px] leading-[1.8] text-ink-800 [overflow-wrap:anywhere] break-words">
        {paraLines.map((pl, idx) => (
          <Fragment key={idx}>
            {idx > 0 && <br />}
            {renderInlineMarkdown(pl, `p-${blocks.length}-${idx}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="min-w-0 [overflow-wrap:anywhere]">{blocks}</div>;
}

function RichBody({ content }: { content: string }) {
  if (!content.trim()) return null;
  return looksLikeHtml(content) ? <HtmlBody html={content} /> : <MarkdownBody text={content} />;
}

export function SnapshotContent({ content }: { content: string }) {
  const { metaLine, body, feishuDoc, relatedDocs, comments } = parseSnapshotSections(content);

  return (
    <div className="min-w-0 space-y-4">
      {metaLine && (
        <div className="rounded-md border border-brand-border/70 bg-brand-subtle/40 px-3 py-1.5 text-[12px] font-medium text-accent [overflow-wrap:anywhere]">
          {metaLine}
        </div>
      )}

      {body && <RichBody content={body} />}

      {feishuDoc && (
        <section className="min-w-0 rounded-lg border border-brand-border bg-brand-subtle/25 p-3.5">
          <h4 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-accent">
            <FileText size={13} />
            {t("飞书文档内容")}
          </h4>
          <RichBody content={feishuDoc} />
        </section>
      )}

      {relatedDocs.length > 0 && (
        <section className="min-w-0 rounded-lg border border-ink-200 bg-surface p-3.5">
          <h4 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-ink-800">
            <Link2 size={13} />
            {t("关联文档")}
          </h4>
          <ul className="space-y-1.5 text-[12.5px] leading-relaxed text-ink-700">
            {relatedDocs.map((docLine, idx) => (
              <li key={idx} className="min-w-0 [overflow-wrap:anywhere] break-words">
                {renderBareUrls(docLine, `rdoc-${idx}`)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {comments.length > 0 && (
        <section className="min-w-0 space-y-2 border-t border-ink-200 pt-3">
          <h4 className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-800">
            <MessageSquareText size={13} />
            {t("精选评论")}
          </h4>
          <div className="space-y-2">
            {comments.map((cm, idx) => (
              <div key={idx} className="min-w-0 rounded-lg border border-ink-200 bg-surface p-3 text-[12.5px] leading-relaxed text-ink-800">
                {cm.author && (
                  <span className="mr-2 inline-flex items-center rounded bg-brand-subtle px-1.5 py-0.5 text-[11px] font-semibold text-accent">
                    {cm.author}
                  </span>
                )}
                <span className="[overflow-wrap:anywhere] break-words">
                  {looksLikeHtml(cm.body) ? <HtmlBody html={cm.body} /> : renderBareUrls(cm.body, `cm-${idx}`)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
