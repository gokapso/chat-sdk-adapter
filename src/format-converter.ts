import {
  BaseFormatConverter,
  parseMarkdown,
  stringifyMarkdown,
  type Content,
  type FormattedContent,
  type Root,
} from "chat";

/** Converts between Chat SDK markdown AST and WhatsApp text formatting. */
export class KapsoFormatConverter extends BaseFormatConverter {
  toAst(platformText: string): Root {
    return parseMarkdown(whatsAppToMarkdown(platformText));
  }

  fromAst(ast: FormattedContent): string {
    return this.fromAstWithNodeConverter(ast, (node) =>
      this.nodeToWhatsApp(node),
    ).trim();
  }

  private nodeToWhatsApp(node: Content): string {
    const value = node as unknown as Record<string, unknown>;
    const children = Array.isArray(value.children)
      ? (value.children as Content[])
      : [];
    const renderChildren = () =>
      children.map((child) => this.nodeToWhatsApp(child)).join("");

    switch (node.type) {
      case "text":
        return String(value.value ?? "");
      case "paragraph":
        return renderChildren();
      case "strong":
        return `*${renderChildren()}*`;
      case "emphasis":
        return `_${renderChildren()}_`;
      case "delete":
        return `~${renderChildren()}~`;
      case "inlineCode":
        return `\`${String(value.value ?? "")}\``;
      case "code":
        return `\`\`\`\n${String(value.value ?? "")}\n\`\`\``;
      case "blockquote":
        return renderChildren()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      case "break":
        return "\n";
      case "link": {
        const label = renderChildren();
        const url = String(value.url ?? "");
        return label && label !== url ? `${label} (${url})` : url;
      }
      case "list":
        return this.renderList(node as never, 0, (child) =>
          this.nodeToWhatsApp(child),
        );
      case "thematicBreak":
        return "---";
      default:
        return this.defaultNodeToText(node, (child) =>
          this.nodeToWhatsApp(child),
        );
    }
  }
}

function whatsAppToMarkdown(input: string): string {
  return input.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1**$2**");
}

export function toStandardMarkdown(input: string): string {
  return stringifyMarkdown(parseMarkdown(whatsAppToMarkdown(input)));
}
