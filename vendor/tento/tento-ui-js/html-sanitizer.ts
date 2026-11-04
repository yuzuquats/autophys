import { Result } from "@tento-core/result";
import { HtmlSanitizerPolyfill } from "./html-sanitizer-polyfill";

export interface SanitizationError {
  message: string;
  input?: string;
}

/**
 * Unified HTML sanitization with automatic native API detection and fallback
 */
export namespace HtmlSanitizer {
  // Configuration for what elements and attributes are allowed
  const ALLOWED_ELEMENTS = [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "strike",
    "del",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "span",
    "ul",
    "ol",
    "li",
    "a",
    "hr",
    "div",
    "dd",
    "dl",
    "dt",
    "small",
    "sub",
    "sup",
  ];

  const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
    a: ["href", "title", "target"],
    ol: ["start"],
    "*": ["class", "id"],
  };

  /**
   * Main sanitization function - automatically uses native or polyfill
   */
  export function sanitize(
    html: string,
  ): Result<Option<string>, SanitizationError> {
    if (!html) {
      return Result.ok(null);
    }

    // Trim and check for empty/bogus content
    html = html.trim();
    if (html === "" || html === "<br>") {
      return Result.ok(null);
    }

    // Try native sanitizer first if available
    if (Native.isSupported()) {
      const result = Native.sanitize(html);
      const error = result.err();

      if (!error) {
        return result;
      }

      // Log warning but don't fail - fall back to polyfill
      console.warn(
        "Native Sanitizer API failed, falling back to polyfill",
        error,
      );
    }

    // Use polyfill (existing HtmlSanitizer)
    return Polyfill.sanitize(html);
  }

  /**
   * Sanitize pasted content with additional cleanup
   */
  export function sanitizePasted(
    html: string,
  ): Result<Option<string>, SanitizationError> {
    const result = sanitize(html);
    const error = result.err();
    const sanitized = result.ok();

    if (error || !sanitized) {
      return result;
    }

    // Additional cleanup for pasted content
    const cleaned = sanitized
      // Remove MS Office specific tags and attributes
      .replace(/<o:p\s*\/?>|<\/o:p>/gi, "")
      .replace(/<!--.*?-->/gs, "") // Remove ALL HTML comments
      .replace(/mso-[^;:"'\s]+:[^;:"']+;?/gi, "")
      // Remove style attributes with mso- properties
      .replace(/style="[^"]*mso-[^"]*"/gi, "")
      // Remove empty spans and divs
      .replace(/<(span|div)(?:\s[^>]*)?>(\s|&nbsp;)*<\/\1>/gi, "")
      // Normalize line breaks (but allow double breaks for paragraphs)
      .replace(/(<br\s*\/?>){3,}/gi, "<br><br>")
      // Remove font tags completely
      .replace(/<\/?font[^>]*>/gi, "")
      // Also remove data URLs
      .replace(/data:[^"'\s]+/gi, "");

    return Result.ok(cleaned);
  }

  /**
   * Native browser Sanitizer API implementation
   */
  export namespace Native {
    export function isSupported(): boolean {
      return typeof window !== "undefined" && "Sanitizer" in window;
    }

    export function sanitize(
      html: string,
    ): Result<string | null, SanitizationError> {
      if (!isSupported()) {
        return Result.err({ message: "Native Sanitizer API not available" });
      }

      try {
        // @ts-ignore - Sanitizer API may not be in TypeScript definitions yet
        const sanitizer = new window.Sanitizer({
          allowElements: ALLOWED_ELEMENTS,
          allowAttributes: ALLOWED_ATTRIBUTES,
          allowCustomElements: false,
          allowComments: false,
        });

        // Create a temporary container
        const container = document.createElement("div");
        container.innerHTML = html;

        // @ts-ignore - Using setHTML which is the newer API
        if (sanitizer.sanitize) {
          // Newer API
          // @ts-ignore
          const cleaned = sanitizer.sanitize(container);
          return Result.ok(cleaned.innerHTML);
        } else if (sanitizer.sanitizeFor) {
          // Older API variant
          // @ts-ignore
          const sanitizedElement = sanitizer.sanitizeFor("div", html);
          if (!sanitizedElement) {
            return Result.err({
              message: "Native sanitizer returned null",
              input: html,
            });
          }
          return Result.ok(sanitizedElement.innerHTML);
        } else {
          return Result.err({
            message: "Native Sanitizer API method not found",
            input: html,
          });
        }
      } catch (e) {
        return Result.err({
          message: `Native sanitizer error: ${e}`,
          input: html,
        });
      }
    }
  }

  /**
   * Polyfill implementation using existing HtmlSanitizer
   */
  export namespace Polyfill {
    export function sanitize(
      html: string,
    ): Result<Option<string>, SanitizationError> {
      try {
        const sanitized = HtmlSanitizerPolyfill.sanitize(html);
        return Result.ok(sanitized);
      } catch (e) {
        return Result.err({
          message: `Polyfill sanitizer error: ${e}`,
          input: html,
        });
      }
    }
  }

  /**
   * Utility function to check if content contains dangerous patterns
   * Used primarily for testing
   */
  export function containsDangerousContent(html: string): boolean {
    if (!html) return false;

    // Remove null bytes for checking
    // biome-ignore lint/suspicious/noControlCharactersInRegex: <explanation>
    const cleanedHtml = html.replace(/\x00/g, "");

    const dangerous = [
      /<script/i,
      /<iframe/i,
      /<object/i,
      /<embed/i,
      /<applet/i,
      /<meta/i,
      /<link/i,
      /<style/i,
      /javascript:/i,
      /on\w+\s*=/i, // Event handlers like onclick, onload, etc.
      /data:text\/html/i,
      /vbscript:/i,
      // Check for script tag with null bytes
      // biome-ignore lint/suspicious/noControlCharactersInRegex: <explanation>
      /scr[\x00]?ipt/i,
    ];

    return dangerous.some((pattern) => pattern.test(cleanedHtml));
  }
}
