import { Fragment, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, FileText, Link2, MessageSquareText } from "lucide-react";
import { t } from "../lib/i18n.ts";
import { isSafeHttpUrl, looksLikeHtml, parseMarkdownBlocks, parseSnapshotSections } from "../lib/snapshot.ts";

const URL_IN_TEXT_RE = /(https?:\/\/[^\s<>()[\]"'，。；！？、]+)/gi;
const INLINE_TOKEN_RE =
  /(!\[([^\]\n]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|<br\s*\/?>|`([^`\n]+)`|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\s][^*\n]*?[^*\s]|[^*\s])\*|https?:\/\/[^\s<>()[\]"'，。；！？、]+)/gi;
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

function SnapshotImage({
  src,
  alt = "",
  compact = false,
  clickable = true,
}: {
  src: string;
  alt?: string;
  compact?: boolean;
  clickable?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const safeSrc = isSafeHttpUrl(src);
  if (!safeSrc || broken) return null;
  const img = (
    <img
      src={safeSrc}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className={
        compact
          ? "max-h-[180px] min-w-[72px] max-w-[180px] rounded-md border border-ink-200 bg-surface object-contain"
          : "max-h-[460px] max-w-full rounded-lg border border-ink-200 bg-surface object-contain"
      }
    />
  );
  if (!clickable) return img;
  return (
    <a
      href={safeSrc}
      target="_blank"
      rel="noopener noreferrer"
      className={compact ? "my-1 block max-w-full" : "my-2.5 block max-w-full"}
    >
      {img}
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

type InlineContext = {
  inLink?: boolean;
  inTable?: boolean;
};

function renderInlineMarkdown(text: string, keyPrefix: string, ctx: InlineContext = {}): ReactNode {
  const nodes: ReactNode[] = [];
  const re = new RegExp(INLINE_TOKEN_RE.source, "gi");
  let lastIndex = 0;
  let idx = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      nodes.push(<Fragment key={`${keyPrefix}-s-${idx++}`}>{text.slice(lastIndex, m.index)}</Fragment>);
    }
    if (m[2] !== undefined && m[3] !== undefined) {
      nodes.push(
        <SnapshotImage
          key={`${keyPrefix}-img-${idx++}`}
          src={m[3]}
          alt={m[2]}
          compact={ctx.inTable}
          clickable={!ctx.inLink}
        />,
      );
    } else if (m[4] !== undefined && m[5] !== undefined) {
      const href = isSafeHttpUrl(m[5]);
      const label = renderInlineMarkdown(m[4], `${keyPrefix}-al-${idx}`, { ...ctx, inLink: true });
      nodes.push(
        href && !ctx.inLink ? (
          <a
            key={`${keyPrefix}-a-${idx++}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent [overflow-wrap:anywhere]"
          >
            {label}
          </a>
        ) : (
          <Fragment key={`${keyPrefix}-at-${idx++}`}>{label}</Fragment>
        ),
      );
    } else if (/^<br\b/i.test(m[0])) {
      nodes.push(<br key={`${keyPrefix}-br-${idx++}`} />);
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
          {renderInlineMarkdown(m[7], `${keyPrefix}-bi-${idx}`, ctx)}
        </strong>,
      );
    } else if (m[8] !== undefined) {
      nodes.push(
        <del key={`${keyPrefix}-del-${idx++}`} className="line-through opacity-75">
          {renderInlineMarkdown(m[8], `${keyPrefix}-di-${idx}`, ctx)}
        </del>,
      );
    } else if (m[9] !== undefined) {
      nodes.push(
        <em key={`${keyPrefix}-em-${idx++}`} className="italic">
          {renderInlineMarkdown(m[9], `${keyPrefix}-ei-${idx}`, ctx)}
        </em>,
      );
    } else {
      const href = ctx.inLink ? null : isSafeHttpUrl(cleanUrl(m[0]));
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
    lastIndex = re.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(<Fragment key={`${keyPrefix}-end`}>{text.slice(lastIndex)}</Fragment>);
  }
  return nodes.length ? nodes : text;
}

const ALIGN_CLASS: Record<"left" | "center" | "right", string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function MarkdownBody({ text }: { text: string }) {
  const parsed = parseMarkdownBlocks(text);

  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      {parsed.map((block, idx) => {
        switch (block.type) {
          case "code":
            return <CodeBlock key={`cb-${idx}`} code={block.code} />;
          case "heading": {
            const content = renderInlineMarkdown(block.text, `h-${idx}`);
            if (block.level === 1) {
              return (
                <h1 key={`h-${idx}`} className="mt-5 mb-2 text-[17px] font-bold leading-snug text-ink-950">
                  {content}
                </h1>
              );
            }
            if (block.level === 2) {
              return (
                <h2 key={`h-${idx}`} className="mt-4 mb-1.5 text-[15px] font-bold leading-snug text-ink-950">
                  {content}
                </h2>
              );
            }
            if (block.level === 3) {
              return (
                <h3 key={`h-${idx}`} className="mt-3.5 mb-1 text-[14px] font-semibold leading-snug text-ink-950">
                  {content}
                </h3>
              );
            }
            return (
              <h4 key={`h-${idx}`} className="mt-3 mb-1 text-[13.5px] font-semibold text-ink-900">
                {content}
              </h4>
            );
          }
          case "hr":
            return <hr key={`hr-${idx}`} className="my-4 border-ink-200" />;
          case "table":
            return (
              <div key={`tbl-${idx}`} className="my-3 max-w-full overflow-x-auto rounded-lg border border-ink-200">
                <table className="min-w-full border-collapse text-left text-[12px] text-ink-800">
                  <thead className="bg-surface-hover font-semibold text-ink-950">
                    <tr className="border-b border-ink-200">
                      {block.headers.map((header, colIdx) => (
                        <th
                          key={`th-${colIdx}`}
                          className={`border-r border-ink-200 px-3 py-2 whitespace-nowrap last:border-r-0 ${ALIGN_CLASS[block.aligns[colIdx] ?? "left"]}`}
                        >
                          {renderInlineMarkdown(header, `tbl-${idx}-h-${colIdx}`, { inTable: true })}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIdx) => (
                      <tr key={`tr-${rowIdx}`} className="border-b border-ink-200 last:border-b-0">
                        {row.map((cell, colIdx) => (
                          <td
                            key={`td-${colIdx}`}
                            className={`min-w-[110px] border-r border-ink-200 px-3 py-2 align-top leading-relaxed last:border-r-0 [overflow-wrap:anywhere] ${ALIGN_CLASS[block.aligns[colIdx] ?? "left"]}`}
                          >
                            {renderInlineMarkdown(cell, `tbl-${idx}-r-${rowIdx}-c-${colIdx}`, { inTable: true })}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "blockquote":
            return (
              <blockquote
                key={`bq-${idx}`}
                className="my-3 rounded-r-lg border-l-[3px] border-brand-border bg-brand-subtle/30 py-2 pr-3 pl-3.5 text-[13px] leading-[1.75] text-ink-700 [overflow-wrap:anywhere]"
              >
                {block.lines.map((ql, lineIdx) => (
                  <p key={lineIdx} className="my-0.5">
                    {renderInlineMarkdown(ql, `bq-${idx}-${lineIdx}`)}
                  </p>
                ))}
              </blockquote>
            );
          case "ul":
            return (
              <ul key={`ul-${idx}`} className="my-2.5 list-disc space-y-1.5 pl-5 text-[13.5px] leading-[1.75] text-ink-800">
                {block.items.map((it, itemIdx) => (
                  <li
                    key={itemIdx}
                    className={`min-w-0 [overflow-wrap:anywhere] break-words ${it.checked !== undefined ? "list-none -ml-4 flex items-start gap-2" : ""}`}
                  >
                    {it.checked !== undefined && (
                      <input
                        type="checkbox"
                        checked={it.checked}
                        readOnly
                        aria-label={it.text}
                        className="mt-1.5 h-3.5 w-3.5 shrink-0 accent-accent"
                      />
                    )}
                    <span className="min-w-0">{renderInlineMarkdown(it.text, `ul-${idx}-${itemIdx}`)}</span>
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={`ol-${idx}`} className="my-2.5 list-decimal space-y-1.5 pl-5 text-[13.5px] leading-[1.75] text-ink-800">
                {block.items.map((it, itemIdx) => (
                  <li key={itemIdx} className="min-w-0 [overflow-wrap:anywhere] break-words">
                    {renderInlineMarkdown(it, `ol-${idx}-${itemIdx}`)}
                  </li>
                ))}
              </ol>
            );
          case "paragraph":
            return (
              <p key={`p-${idx}`} className="my-2.5 text-[13.5px] leading-[1.8] text-ink-800 [overflow-wrap:anywhere] break-words">
                {block.lines.map((pl, lineIdx) => (
                  <Fragment key={lineIdx}>
                    {lineIdx > 0 && <br />}
                    {renderInlineMarkdown(pl, `p-${idx}-${lineIdx}`)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}

function RichBody({ content }: { content: string }) {
  if (!content.trim()) return null;
  return looksLikeHtml(content) ? <HtmlBody html={content} /> : <MarkdownBody text={content} />;
}

function CommentText({ body, keyPrefix }: { body: string; keyPrefix: string }) {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (looksLikeHtml(trimmed)) {
    return <HtmlBody html={trimmed} />;
  }
  if (trimmed.includes("\n") || /!\[[^\]]*\]\(https?:\/\//.test(trimmed) || /^```/m.test(trimmed)) {
    return <MarkdownBody text={trimmed} />;
  }
  return <span className="[overflow-wrap:anywhere] break-words">{renderInlineMarkdown(trimmed, keyPrefix)}</span>;
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
        <section className="min-w-0 space-y-2.5 border-t border-ink-200 pt-3">
          <h4 className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-800">
            <MessageSquareText size={13} />
            <span>{t("精选评论")}</span>
            <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-600">
              {comments.length}
            </span>
          </h4>
          <div className="space-y-2.5">
            {comments.map((cm, idx) => (
              <div
                key={idx}
                className={
                  "min-w-0 rounded-lg border p-3 text-[12.5px] leading-relaxed text-ink-800 " +
                  (cm.isAuthor ? "border-brand-border/80 bg-brand-subtle/20" : "border-ink-200 bg-surface")
                }
              >
                {(cm.author || cm.isAuthor || (cm.likes ?? 0) > 0) && (
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    {cm.author && (
                      <span className="inline-flex items-center rounded bg-brand-subtle px-1.5 py-0.5 text-[11px] font-semibold text-accent">
                        {cm.author}
                      </span>
                    )}
                    {cm.isAuthor && (
                      <span className="inline-flex items-center rounded border border-code-border bg-code-subtle px-1.5 py-0.5 text-[10.5px] font-semibold text-code">
                        {t("楼主")}
                      </span>
                    )}
                    {typeof cm.likes === "number" && cm.likes > 0 && (
                      <span className="inline-flex items-center rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-600">
                        👍 {cm.likes}
                      </span>
                    )}
                  </div>
                )}

                <div className="min-w-0 [overflow-wrap:anywhere] break-words">
                  <CommentText body={cm.body} keyPrefix={`cm-${idx}`} />
                </div>

                {cm.replies && cm.replies.length > 0 && (
                  <div className="mt-2.5 space-y-2 border-l-2 border-ink-200 pl-3">
                    {cm.replies.map((rp, rIdx) => (
                      <div key={rIdx} className="min-w-0 text-[12px] leading-relaxed text-ink-700">
                        <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
                          {rp.author && <span className="font-semibold text-ink-900">{rp.author}</span>}
                          {rp.isAuthor && (
                            <span className="inline-flex items-center rounded border border-code-border bg-code-subtle px-1 py-px text-[10px] font-semibold text-code">
                              {t("楼主")}
                            </span>
                          )}
                          {rp.replyTo && (
                            <span className="text-[11px] text-ink-500">
                              {t("回复")} <span className="font-medium text-ink-700">{rp.replyTo}</span>
                            </span>
                          )}
                          {typeof rp.likes === "number" && rp.likes > 0 && (
                            <span className="font-mono text-[10.5px] text-ink-500">👍 {rp.likes}</span>
                          )}
                        </div>
                        <div className="min-w-0 [overflow-wrap:anywhere] break-words">
                          <CommentText body={rp.body} keyPrefix={`cm-${idx}-r-${rIdx}`} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
