/**
 * Zalo-specific format conversion using AST-based parsing.
 *
 * Zalo `sendMessage` accepts plain `text` plus an optional `text_styles` array
 * (UTF-16 offset runs with style codes such as `b`, `i`, `s`). The converter
 * walks the markdown AST once and produces both, so literal characters such as
 * `*` or `_` never need escaping and are never misread as markup.
 *
 * @see https://bot.zapps.me/docs/apis/sendMessage/
 */

import {
  type AdapterPostableMessage,
  BaseFormatConverter,
  type Content,
  isTableNode,
  parseMarkdown,
  type Root,
  tableToAscii,
} from "chat";
import type { ZaloTextStyle } from "./types";

/** Plain text together with the style runs that apply to it. */
export interface ZaloRichText {
  styles: ZaloTextStyle[];
  text: string;
}

/** Style codes used when rendering (subset of the codes Zalo accepts). */
const BOLD = "b";
const ITALIC = "i";
const STRIKE = "s";
const LARGE = "f_18";

type AnyNode = Content & {
  alt?: string | null;
  checked?: boolean | null;
  children?: AnyNode[];
  depth?: number;
  ordered?: boolean | null;
  spread?: boolean | null;
  start?: number | null;
  url?: string;
  value?: string;
};

/**
 * Append `value` to the builder, applying `active` styles. Runs never span a
 * newline so that line prefixes (quotes, list markers) can be inserted later
 * without styling them.
 */
function append(out: ZaloRichText, value: string, active: string[]): void {
  if (value.length === 0) {
    return;
  }
  if (active.length === 0) {
    out.text += value;
    return;
  }
  let offset = 0;
  for (const line of value.split("\n")) {
    if (line.length > 0) {
      pushRun(out, out.text.length + offset, line.length, active);
    }
    offset += line.length + 1;
  }
  out.text += value;
}

/** Add a run, merging with the previous one when contiguous and identical. */
function pushRun(
  out: ZaloRichText,
  start: number,
  len: number,
  st: string[],
): void {
  const last = out.styles.at(-1);
  if (
    last &&
    last.start + last.len === start &&
    last.st.length === st.length &&
    last.st.every((code, i) => code === st[i])
  ) {
    last.len += len;
    return;
  }
  out.styles.push({ start, len, st: [...st] });
}

/**
 * Prefix every line of `block` (`first` for line 1, `rest` for the others),
 * shifting style runs accordingly. Blank lines are left unprefixed.
 */
function prefixLines(
  block: ZaloRichText,
  first: string,
  rest: string,
): ZaloRichText {
  let text = "";
  // old offset of each line start -> number of prefix chars inserted before it
  const shifts: Array<{ at: number; added: number }> = [];
  let added = 0;
  let pos = 0;
  const lines = block.text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const prefix = i === 0 ? first : rest;
    if (line.length > 0) {
      added += prefix.length;
      text += prefix;
    }
    shifts.push({ at: pos, added });
    text += line;
    if (i < lines.length - 1) {
      text += "\n";
    }
    pos += line.length + 1;
  }

  const styles = block.styles.map((run) => {
    // Runs never span newlines, so one lookup of the owning line is enough.
    let shift = 0;
    for (const s of shifts) {
      if (s.at <= run.start) {
        shift = s.added;
      } else {
        break;
      }
    }
    return { ...run, start: run.start + shift };
  });
  return { text, styles };
}

/** Concatenate `parts` with `separator`, shifting style runs. */
function join(parts: ZaloRichText[], separator: string): ZaloRichText {
  const out: ZaloRichText = { text: "", styles: [] };
  parts.forEach((part, i) => {
    if (i > 0) {
      out.text += separator;
    }
    const base = out.text.length;
    for (const run of part.styles) {
      out.styles.push({ ...run, start: run.start + base });
    }
    out.text += part.text;
  });
  return out;
}

function renderInline(
  nodes: AnyNode[] | undefined,
  out: ZaloRichText,
  active: string[],
): void {
  for (const node of nodes ?? []) {
    renderInlineNode(node, out, active);
  }
}

function withStyle(active: string[], code: string): string[] {
  return active.includes(code) ? active : [...active, code];
}

function renderInlineNode(
  node: AnyNode,
  out: ZaloRichText,
  active: string[],
): void {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "html":
      append(out, node.value ?? "", active);
      return;
    case "break":
      append(out, "\n", []);
      return;
    case "strong":
      renderInline(node.children, out, withStyle(active, BOLD));
      return;
    case "emphasis":
      renderInline(node.children, out, withStyle(active, ITALIC));
      return;
    case "delete":
      renderInline(node.children, out, withStyle(active, STRIKE));
      return;
    case "link": {
      const before = out.text.length;
      renderInline(node.children, out, active);
      const label = out.text.slice(before);
      const url = node.url ?? "";
      if (url && label !== url && `mailto:${label}` !== url) {
        append(out, label ? ` (${url})` : url, []);
      }
      return;
    }
    case "image":
      append(out, node.alt || node.url || "", active);
      return;
    default:
      if (node.children) {
        renderInline(node.children, out, active);
      } else if (node.value) {
        append(out, node.value, active);
      }
  }
}

function renderBlocks(nodes: AnyNode[] | undefined, tight: boolean) {
  return join(
    (nodes ?? []).map((node) => renderBlock(node)),
    tight ? "\n" : "\n\n",
  );
}

function renderBlock(node: AnyNode): ZaloRichText {
  switch (node.type) {
    case "heading": {
      const out: ZaloRichText = { text: "", styles: [] };
      const active = node.depth === 1 ? [BOLD, LARGE] : [BOLD];
      renderInline(node.children, out, active);
      return out;
    }
    case "blockquote":
      return prefixLines(renderBlocks(node.children, false), "> ", "> ");
    case "list":
      return renderList(node);
    case "code":
      return { text: node.value ?? "", styles: [] };
    case "thematicBreak":
      return { text: "---", styles: [] };
    case "table":
      return isTableNode(node)
        ? { text: tableToAscii(node), styles: [] }
        : { text: "", styles: [] };
    default: {
      const out: ZaloRichText = { text: "", styles: [] };
      renderInlineNode(node, out, []);
      return out;
    }
  }
}

function renderList(node: AnyNode): ZaloRichText {
  const first = node.start ?? 1;
  const items = (node.children ?? []).map((item, i) => {
    const marker = node.ordered ? `${first + i}. ` : "- ";
    const check =
      item.checked === true ? "[x] " : item.checked === false ? "[ ] " : "";
    const body = renderBlocks(item.children, item.spread !== true);
    return prefixLines(
      {
        text: check + body.text,
        styles: body.styles.map((run) => ({
          ...run,
          start: run.start + check.length,
        })),
      },
      marker,
      " ".repeat(marker.length),
    );
  });
  return join(items, "\n");
}

/**
 * Render an AST to plain text and style runs.
 */
export function astToRichText(ast: Root): ZaloRichText {
  const rich = renderBlocks(ast.children as AnyNode[], false);
  const text = rich.text.trimEnd();
  const styles = rich.styles
    .filter((run) => run.start < text.length)
    .map((run) => ({
      ...run,
      len: Math.min(run.len, text.length - run.start),
    }));
  return { text, styles };
}

export class ZaloFormatConverter extends BaseFormatConverter {
  /**
   * Convert an AST to plain text for Zalo (formatting markers removed).
   */
  fromAst(ast: Root): string {
    return astToRichText(ast).text;
  }

  /**
   * Parse text from Zalo into an AST.
   */
  toAst(text: string): Root {
    return parseMarkdown(text);
  }

  /**
   * Render a postable message to plain text for Zalo.
   */
  override renderPostable(message: AdapterPostableMessage): string {
    return this.renderPostableRich(message).text;
  }

  /**
   * Render a postable message to text plus style runs. Strings and `raw`
   * messages are passed through unformatted.
   */
  renderPostableRich(message: AdapterPostableMessage): ZaloRichText {
    if (typeof message === "string") {
      return { text: message, styles: [] };
    }
    if ("raw" in message) {
      return { text: message.raw, styles: [] };
    }
    if ("markdown" in message) {
      return astToRichText(parseMarkdown(message.markdown));
    }
    if ("ast" in message) {
      return astToRichText(message.ast);
    }
    return { text: super.renderPostable(message), styles: [] };
  }
}
