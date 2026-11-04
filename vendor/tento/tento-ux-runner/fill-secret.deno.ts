// `fill_secret` for agent-driven `ux-test run --auto`: the harness, not the
// agent, types an allowlisted password into Google's password page.
//
// `tento-ux-test` (src/fill_secret.rs) runs this when the agent asks for a
// secret by name, AFTER it has checked that the name is allowlisted for the
// spec's account and read the secret file itself. The Rust side embeds this
// file (`include_str!`) and writes it beside the run, outside the agent's
// workspace, so the script always matches the binary that runs it.
//
//   deno run --no-prompt --cached-only --config <runner>/deno.json \
//     --allow-net=127.0.0.1:<port> --allow-read=<out> --allow-write=<out> --allow-env \
//     fill-secret.deno.ts <devtools-url> <out-dir>   < secret
//
// The secret arrives on STDIN only. It is never printed, logged, written, or
// passed anywhere but the one password input this script checked:
//   - the focused field of the browser's one page that has a focused field,
//   - on a page whose origin is EXACTLY https://accounts.google.com,
//   - an <input type="password"> that is visible.
// Anything else is refused, and nothing is typed. The script never presses
// Enter: the agent clicks Next, as a person would.
//
// Exactly one status line goes to stdout, last:
//   fill-secret: filled <origin>       exit 0
//   fill-secret: refused <reason>      exit 4
//   fill-secret: error <reason>        exit 1

import puppeteer from "npm:puppeteer-core@22.7.1";
import type { Browser, Page } from "npm:puppeteer-core@22.7.1";

export const GOOGLE_ORIGIN = "https://accounts.google.com";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 4;

/** The focused element of one page, as far as the decision needs it. Never
 *  carries a value. */
export type Field = {
  /** Lower-case tag name. */
  tag: string;
  /** Lower-case `type` of an input, "" otherwise. */
  type: string;
  /** Something a person could type into: a text-like input, a textarea, or
   *  contenteditable. A focused button or link is not. */
  editable: boolean;
  visible: boolean;
};

/** What one page shows. */
export type PageView = {
  url: string;
  /** The deepest focused element (through open shadow roots), or null. */
  active: Field | null;
  visiblePasswords: number;
};

export type Decision =
  | { ok: true; index: number; origin: string }
  | { ok: false; reason: string };

/** The URL's serialized origin (`"null"` for an opaque one), or null when it
 *  does not parse. Userinfo, case and a default port do not survive it, so
 *  `https://accounts.google.com@evil.example` is `https://evil.example`. */
export function exactOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function describe(field: Field): string {
  return field.tag === "input" && field.type
    ? `input[type=${field.type}]`
    : field.tag;
}

/** Which page to type into, or why not. Pure, so every refusal is tested
 *  without a browser. */
export function decide(pages: PageView[]): Decision {
  const focused = pages
    .map((view, index) => ({ view, index }))
    .filter(({ view }) => view.active?.editable);
  if (focused.length === 0) return { ok: false, reason: "no-focused-field" };
  if (focused.length > 1) {
    return { ok: false, reason: "several-focused-fields" };
  }
  const { view, index } = focused[0];
  const origin = exactOrigin(view.url);
  if (origin !== GOOGLE_ORIGIN) {
    return { ok: false, reason: `wrong-origin ${origin ?? "unparseable"}` };
  }
  const field = view.active!;
  if (field.tag !== "input" || field.type !== "password") {
    return { ok: false, reason: `not-a-password-field ${describe(field)}` };
  }
  if (!field.visible) {
    return { ok: false, reason: "password-field-not-visible" };
  }
  return { ok: true, index, origin };
}

/** Stdin, exactly: `ux-test` already dropped the file's one trailing newline. */
async function readSecret(): Promise<string> {
  return await new Response(Deno.stdin.readable).text();
}

/** The page's focused element, read in the page. With `tag`, it is also
 *  marked `data-ux-fill` so `ElementHandle.type` can reach exactly it. */
async function view(page: Page, tag: boolean): Promise<PageView> {
  const url = page.url();
  try {
    const seen = await page.evaluate((mark: boolean) => {
      for (
        const el of Array.from(document.querySelectorAll("[data-ux-fill]"))
      ) {
        el.removeAttribute("data-ux-fill");
      }
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
          style.visibility !== "hidden" && style.display !== "none";
      };
      let active: Element | null = document.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      const NOT_TEXT = [
        "button",
        "submit",
        "reset",
        "checkbox",
        "radio",
        "image",
        "file",
        "hidden",
        "range",
        "color",
      ];
      let field = null;
      if (
        active && active !== document.body &&
        active !== document.documentElement
      ) {
        const tagName = active.tagName.toLowerCase();
        const type = tagName === "input"
          ? ((active as HTMLInputElement).type || "text").toLowerCase()
          : "";
        const editable = (tagName === "input" && !NOT_TEXT.includes(type)) ||
          tagName === "textarea" || (active as HTMLElement).isContentEditable;
        field = { tag: tagName, type, editable, visible: visible(active) };
        if (mark) active.setAttribute("data-ux-fill", "1");
      }
      const visiblePasswords = Array.from(
        document.querySelectorAll('input[type="password"]'),
      ).filter(visible).length;
      return { active: field, visiblePasswords, href: location.href };
    }, tag);
    return {
      url: seen.href || url,
      active: seen.active,
      visiblePasswords: seen.visiblePasswords,
    };
  } catch {
    // Mid-navigation, or a page that cannot run script: nothing focused here.
    return { url, active: null, visiblePasswords: 0 };
  }
}

type Outcome = { line: string; code: number };

const refused = (reason: string): Outcome => ({
  line: `fill-secret: refused ${reason}`,
  code: EXIT_REFUSED,
});

async function fill(browser: Browser, secret: string): Promise<Outcome> {
  const pages = await browser.pages();
  const views = [];
  for (const page of pages) views.push(await view(page, false));
  const decision = decide(views);
  if (!decision.ok) return refused(decision.reason);
  const page = pages[decision.index];

  // Look again, on the page itself, with the field marked: the page may have
  // moved since the decision.
  const again = decide([await view(page, true)]);
  if (!again.ok) return refused(`page-changed ${again.reason}`);
  const handle = await page.$('[data-ux-fill="1"]');
  if (!handle) return refused("page-changed field-gone");
  try {
    // Replace whatever the field holds, then type as a person would.
    await handle.evaluate((el) => (el as HTMLInputElement).select());
    await handle.type(secret, { delay: 40 });
  } catch {
    // Deliberately no detail: nothing about the input's value may leave.
    return {
      line: "fill-secret: error typing into the password field failed",
      code: EXIT_ERROR,
    };
  } finally {
    await handle.evaluate((el) => el.removeAttribute("data-ux-fill")).catch(
      () => {},
    );
    await handle.dispose().catch(() => {});
  }
  if (exactOrigin(page.url()) !== GOOGLE_ORIGIN) {
    return {
      line: "fill-secret: error the page left accounts.google.com while typing",
      code: EXIT_ERROR,
    };
  }
  return { line: `fill-secret: filled ${decision.origin}`, code: EXIT_OK };
}

async function main(): Promise<number> {
  const [browserURL, outDir] = Deno.args;
  if (!browserURL || !outDir) {
    console.error(
      "usage: fill-secret.deno.ts <devtools-url> <out-dir> < secret",
    );
    console.log("fill-secret: error usage");
    return EXIT_USAGE;
  }
  const secret = await readSecret();
  if (secret.length === 0) {
    console.log("fill-secret: error no secret on stdin");
    return EXIT_USAGE;
  }
  let browser: Browser | null = null;
  let outcome: Outcome;
  try {
    browser = await puppeteer.connect({
      browserURL,
      defaultViewport: null,
      protocolTimeout: 30_000,
    });
    outcome = await fill(browser, secret);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An error never carries the secret: it is only ever an argument to
    // `handle.type`, whose failures are caught above without their message.
    outcome = {
      line: `fill-secret: error ${
        message.replace(/\s+/g, " ").trim().slice(0, 160)
      }`,
      code: EXIT_ERROR,
    };
  } finally {
    // The browser and its pages belong to ux-test and the agent.
    await browser?.disconnect().catch(() => {});
  }
  console.log(outcome.line);
  return outcome.code;
}

if (import.meta.main) {
  Deno.exit(await main());
}
