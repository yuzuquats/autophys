import { matchAll } from "@tento-core/polyfill";

// Precompiled regex patterns for better performance
const LINK_REGEX =
  /((?:(http|https|Http|Https|rtsp|Rtsp):\/\/(?:(?:[a-zA-Z0-9\$\-\_\.\+\!\*\'\(\)\,\;\?\&\=]|(?:\%[a-fA-F0-9]{2})){1,64}(?:\:(?:[a-zA-Z0-9\$\-\_\.\+\!\*\'\(\)\,\;\?\&\=]|(?:\%[a-fA-F0-9]{2})){1,25})?\@)?)?((?:(?:[a-zA-Z0-9][a-zA-Z0-9\-]{0,64}\.)+(?:(?:aero|arpa|asia|a[cdefgilmnoqrstuwxz])|(?:biz|b[abdefghijmnorstvwyz])|(?:cat|com|coop|c[acdfghiklmnoruvxyz])|d[ejkmoz]|(?:edu|e[cegrstu])|f[ijkmor]|(?:gov|g[abdefghilmnpqrstuwy])|h[kmnrtu]|(?:info|int|i[delmnoqrst])|(?:jobs|j[emop])|k[eghimnrwyz]|l[abcikrstuvy]|(?:mil|mobi|museum|m[acdghklmnopqrstuvwxyz])|(?:name|net|n[acefgilopruz])|(?:org|om)|(?:pro|p[aefghklmnrstwy])|qa|r[eouw]|s[abcdeghijklmnortuvyz]|(?:tel|travel|t[cdfghjklmnoprtvwz])|u[agkmsyz]|v[aceginu]|w[fs]|y[etu]|z[amw]))|(?:(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[1-9])\.(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[1-9]|0)\.(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[1-9]|0)\.(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[0-9])))(?:\:\d{1,5})?)(\/((?:[a-zA-Z0-9\;\/\?\:\@\&\=\#\~\-\.\+\!\*\'\(\)\,\_])|(?:\%[a-fA-F0-9]{2}))*)?(?:\b|$)/gi;

// Use Sets for better performance on lookups
const TAG_WHITELIST = new Set([
  "A",
  "ABBR",
  "B",
  "BLOCKQUOTE",
  "BODY",
  "BR",
  "CENTER",
  "CODE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "EM",
  "FONT",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "I",
  "IMG",
  "LABEL",
  "LI",
  "OL",
  "P",
  "PRE",
  "SMALL",
  "SOURCE",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "TABLE",
  "TBODY",
  "TR",
  "TD",
  "TH",
  "THEAD",
  "UL",
  "U",
  "VIDEO",
]);

const CONTENT_TAG_WHITELIST = new Set(["FORM", "GOOGLE-SHEETS-HTML-ORIGIN"]);

const ATTRIBUTE_WHITELIST = new Set([
  "align",
  "color",
  "controls",
  "height",
  "href",
  "id",
  "src",
  "style",
  "target",
  "title",
  "type",
  "width",
]);

const CSS_WHITELIST = new Set([
  "background-color",
  "color",
  "font-size",
  "font-weight",
  "text-align",
  "text-decoration",
  "width",
]);

const URI_ATTRIBUTES = new Set(["href", "action", "src"]);

// Safer schema whitelist (removed file:)
const SAFE_SCHEMAS = ["http:", "https:", "mailto:", "ftp:"];

// Precompiled dangerous patterns for regex fallback
const DANGEROUS_TAGS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "meta",
  "link",
  "applet",
  "base",
];
const DANGEROUS_TAG_PATTERN = new RegExp(
  `<(${DANGEROUS_TAGS.join("|")})[^>]*>[\\s\\S]*?</\\1>|<(${DANGEROUS_TAGS.join("|")})[^>]*\\/?>`,
  "gi",
);

export namespace HtmlSanitizerPolyfill {
  function linkifyNode(node: Node): Node[] {
    const input = node.nodeValue;
    if (!input) {
      return [node];
    }

    const matches = matchAll(input, LINK_REGEX);
    if (matches.length === 0) {
      return [node];
    }

    const nodes: Node[] = [];
    let start = 0;

    for (const match of matches) {
      const end = match.index + match[0].length;

      // Add text before link
      if (start !== match.index) {
        const text = input.slice(start, match.index);
        nodes.push(document.createTextNode(text));
      }

      // Create link element
      const url = input.slice(match.index, end);
      const link = document.createElement("a");
      link.target = "_blank";
      link.href = url;
      link.textContent = url;
      nodes.push(link);

      start = end;
    }

    // Add remaining text
    if (start < input.length) {
      nodes.push(document.createTextNode(input.slice(start)));
    }

    return nodes;
  }

  function isSchemaAllowed(value: string): boolean {
    const colonIndex = value.indexOf(":");
    if (colonIndex === -1) return true;

    const schema = value.substring(0, colonIndex + 1).toLowerCase();
    return SAFE_SCHEMAS.includes(schema);
  }

  function makeSanitizedCopy(doc: Document, node: Node): Node[] {
    if (node.nodeType === Node.TEXT_NODE) {
      return linkifyNode(node);
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      const tagName = element.tagName;

      // Check if tag is allowed
      if (!TAG_WHITELIST.has(tagName) && !CONTENT_TAG_WHITELIST.has(tagName)) {
        return [doc.createDocumentFragment()];
      }

      // Create new element (convert content tags to div)
      const newElement = CONTENT_TAG_WHITELIST.has(tagName)
        ? doc.createElement("div")
        : doc.createElement(tagName);

      // Copy allowed attributes
      for (const attr of element.attributes) {
        if (!ATTRIBUTE_WHITELIST.has(attr.name)) continue;

        if (attr.name === "style") {
          // Copy only allowed styles
          for (let i = 0; i < element.style.length; i++) {
            const styleName = element.style[i];
            if (CSS_WHITELIST.has(styleName)) {
              newElement.style.setProperty(
                styleName,
                element.style.getPropertyValue(styleName),
              );
            }
          }
        } else if (URI_ATTRIBUTES.has(attr.name)) {
          // Validate URI attributes
          if (!isSchemaAllowed(attr.value)) continue;
          newElement.setAttribute(attr.name, attr.value);
        } else {
          newElement.setAttribute(attr.name, attr.value);
        }
      }

      // Process children
      for (const child of node.childNodes) {
        const sanitizedChildren = makeSanitizedCopy(doc, child);
        for (const sanitizedChild of sanitizedChildren) {
          newElement.appendChild(sanitizedChild);
        }
      }

      // Remove empty inline elements
      if (
        ["SPAN", "B", "I", "U"].includes(tagName) &&
        !newElement.innerHTML.trim()
      ) {
        return [doc.createDocumentFragment()];
      }

      return [newElement];
    }

    return [doc.createDocumentFragment()];
  }

  function sanitizeWithRegex(input: string): string {
    // Decode HTML entities that might hide dangerous content
    let cleaned = input
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#60;/g, "<")
      .replace(/&#62;/g, ">")
      .replace(/&#x3C;/gi, "<")
      .replace(/&#x3E;/gi, ">");

    // Remove dangerous tags in one pass
    cleaned = cleaned.replace(DANGEROUS_TAG_PATTERN, "");

    // Remove event handlers and dangerous protocols
    cleaned = cleaned
      .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, "") // Quoted event handlers
      .replace(/\son\w+\s*=/gi, "") // Unquoted event handlers
      .replace(/javascript:/gi, "")
      .replace(/vbscript:/gi, "")
      .replace(/data:text\/html[^"'\s]*/gi, "") // Data URLs with HTML
      // biome-ignore lint/suspicious/noControlCharactersInRegex: needed for security
      .replace(/\x00/g, "") // Null bytes
      .replace(/<!--.*?-->/gs, ""); // HTML comments

    // Remove font tags
    cleaned = cleaned.replace(/<\/?font[^>]*>/gi, "");

    // Final safety check for any remaining script content
    cleaned = cleaned.replace(/alert\s*\([^)]*\)/gi, "");

    // Remove any tags containing "script" that might have been missed
    if (/<.*script.*>/i.test(cleaned)) {
      cleaned = cleaned.replace(/<[^>]*script[^>]*>/gi, "");
    }

    return cleaned;
  }

  export function sanitize(input: Option<string>): Option<string> {
    if (input == null) return null;
    input = input.trim();
    if (input === "" || input === "<br>") return null;

    const PARSER = typeof DOMParser !== "undefined" ? new DOMParser() : null;

    // Use regex fallback if DOMParser is not available
    if (!PARSER) {
      return sanitizeWithRegex(input);
    }

    // Prepare input for parsing
    input = input.replace("html-blob", "body");
    if (!input.includes("<body")) {
      input = `<body>${input}</body>`;
    }

    const doc = PARSER.parseFromString(input, "text/html");

    // DOM clobbering protection
    if (doc.body.tagName !== "BODY") {
      doc.body.remove();
    }

    if (typeof doc.createElement !== "function") {
      doc.createElement = () => {
        throw new Error();
      };
    }

    const result = makeSanitizedCopy(doc, doc.body)[0] as HTMLElement;

    // Set target="_blank" on all links
    for (const link of result.querySelectorAll("a")) {
      link.target = "_blank";
    }

    return result.innerHTML
      .replace(/<br[^>]*>(\S)/g, "<br>\n$1")
      .replace(/div><div/g, "div>\n<div");
  }
}
