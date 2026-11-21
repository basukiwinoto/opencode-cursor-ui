/**
 * Markdown renderer for assistant messages.
 *
 * Security posture (matches the webview CSP):
 * - No remote images: <img> nodes are replaced by an alt-text placeholder
 *   and never receive a src.
 * - Links open in a new context with noopener; VS Code handles the shell.
 * - Code blocks get a language label + local clipboard copy button.
 */
import { Children, isValidElement, memo, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Icon } from "./Icon";

const MAX_COPY_LENGTH = 100_000;

/** Extract plain text from hast-rendered React children (for copying code). */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) {
    const children = (node.props as { children?: ReactNode }).children;
    return nodeText(children);
  }
  return "";
}

function languageOf(children: ReactNode): { lang: string; code: string } {
  const child = Children.toArray(children).find(
    (c): c is ReactElement<{ className?: string; children?: ReactNode }> =>
      isValidElement(c) && c.type === "code",
  );
  if (!child) return { lang: "", code: nodeText(children) };
  const className = child.props.className ?? "";
  const lang = /language-([\w+#.-]+)/.exec(className)?.[1] ?? "";
  return { lang, code: nodeText(child.props.children ?? []) };
}

function PreBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const { lang, code } = languageOf(children);

  const onCopy = () => {
    const text = code.slice(0, MAX_COPY_LENGTH);
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  };

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang || "code"}</span>
        <button
          type="button"
          className="md-code-copy"
          onClick={onCopy}
          aria-label={copied ? "Code copied" : "Copy code"}
        >
          <Icon name={copied ? "check" : "copy"} size={12} />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: PreBlock,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" title={href}>
      {children}
    </a>
  ),
  // CSP forbids remote images; render an alt-text placeholder instead.
  img: ({ alt }) => (
    <span className="md-img-alt" role="img" aria-label={alt ?? "image"}>
      <Icon name="file" size={12} />
      <span>{alt || "image unavailable"}</span>
    </span>
  ),
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
