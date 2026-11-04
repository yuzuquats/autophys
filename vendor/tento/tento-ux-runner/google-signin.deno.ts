// Google sign-in pre-step for agent-driven `ux-test run --auto`.
//
// `tento-ux-test` (src/agent.rs) runs this against the run's own browser — the
// tester's persistent profile, on a private DevTools port the agent is never
// told — BEFORE the browser the agent drives is started, so the agent inherits
// a live Google session and never sees a password page. The Rust side embeds
// this file (`include_str!`) and writes it beside the run, so the script always
// matches the binary that runs it.
//
//   deno run --no-prompt --cached-only --config <runner>/deno.json \
//     --allow-net=127.0.0.1:<port> --allow-read=<out> --allow-write=<out> --allow-env \
//     google-signin.deno.ts <devtools-url> <account> <out-dir>   < password
//
// The password arrives on STDIN only, byte for byte. It is never printed, logged, written, or
// passed anywhere but the focused password input, and no screenshot is taken
// while a password field holds a value.
//
// Exactly one status line goes to stdout, last:
//   google-signin: already-signed-in          exit 0
//   google-signin: signed-in                  exit 0
//   google-signin: needs-human <reason>       exit 3  (screenshot in <out-dir>)
//   google-signin: timeout <state>            exit 1
//   google-signin: error <reason>             exit 1
//
// The pages it drives are the identifier field, the account chooser, the
// password field, Google's sign-in-again interstitial ("Verify it's you … Please
// sign in again to continue", the account and one Next button, off any
// /challenge/ path: Next is clicked at most once, which leads to the password
// field) and post-sign-in prompts (skipped by going to the account page). Every
// other page is a human's: any /challenge/ path (phone tap, codes, security
// key), 2-Step Verification, a captcha and every other "verify it's you"
// variant are `needs-human`. A second factor is never automated.
//
// No user-agent override, no stealth, no Emulation.*: a provider that refuses
// this browser is a result (`needs-human provider-rejects-browser`).

import puppeteer from "npm:puppeteer-core@22.7.1";
import type { Browser, Page } from "npm:puppeteer-core@22.7.1";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_NEEDS_HUMAN = 3;

/** The whole pre-step's budget. The Rust side kills the process a little later. */
const DEADLINE_MS = 75_000;
/** How long an unrecognised page may sit still before it is a human's problem. */
const STUCK_MS = 20_000;
const POLL_MS = 500;

/** Where to land when signed in: Google's own account page, as the account. */
export function continueUrl(account: string): string {
  return `https://myaccount.google.com/?authuser=${
    encodeURIComponent(account)
  }`;
}

export function signinUrl(account: string): string {
  return `https://accounts.google.com/ServiceLogin?continue=${
    encodeURIComponent(continueUrl(account))
  }&Email=${encodeURIComponent(account)}`;
}

/** What one poll of the sign-in tab saw. Never carries an input's value. */
export type Snapshot = {
  url: string;
  /** Visible body text, truncated. */
  text: string;
  hasIdentifier: boolean;
  hasPassword: boolean;
  /** The account chooser lists `account` (`[data-identifier]`, or
   * `[data-email]` on the chooser variant Google also serves). */
  chooserHasAccount: boolean;
  hasCaptcha: boolean;
  /** The page's markup names `account` (myaccount's account menu does). */
  accountInPage: boolean;
};

export type State =
  | { kind: "myaccount" }
  | { kind: "password" }
  | { kind: "identifier" }
  | { kind: "chooser" }
  /** "Verify it's you … sign in again to continue": the account and a Next
   * button that leads to the password field. Not a second factor. */
  | { kind: "reauth" }
  | { kind: "interstitial" }
  | { kind: "needs-human"; reason: string }
  | { kind: "other" };

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Decide what the tab is showing. Pure, so it is tested without a browser. */
export function classify(snap: Snapshot, typedPassword: boolean): State {
  const url = parse(snap.url);
  const host = url?.hostname ?? "";
  const path = url?.pathname ?? "";
  const text = snap.text;

  if (
    /this browser or app may not be secure/i.test(text) ||
    /couldn.t sign you in/i.test(text) ||
    /\/signin\/rejected/.test(path)
  ) {
    return { kind: "needs-human", reason: "provider-rejects-browser" };
  }
  if (snap.hasCaptcha || /type the text you hear or see/i.test(text)) {
    return { kind: "needs-human", reason: "captcha" };
  }
  if (
    (host === "accounts.google.com" && /\/challenge\/pwd/.test(path)) ||
    snap.hasPassword
  ) {
    if (typedPassword && /wrong password/i.test(text)) {
      return { kind: "needs-human", reason: "wrong-password" };
    }
    return { kind: "password" };
  }
  if (host === "accounts.google.com") {
    const challenge = path.match(/\/challenge\/([a-z0-9_-]+)/i);
    if (challenge) {
      return {
        kind: "needs-human",
        reason: `challenge-${challenge[1].toLowerCase()}`,
      };
    }
    if (/2-step verification/i.test(text)) {
      return { kind: "needs-human", reason: "2-step-verification" };
    }
    if (/verify it.s you/i.test(text)) {
      // Only the sign-in-again interstitial is driven; the /challenge/ paths
      // and 2-Step Verification were decided above.
      if (/sign in again to continue/i.test(text)) return { kind: "reauth" };
      return { kind: "needs-human", reason: "verify-its-you" };
    }
    if (snap.hasIdentifier) return { kind: "identifier" };
    if (snap.chooserHasAccount) return { kind: "chooser" };
    if (/\/speedbump\//.test(path)) return { kind: "interstitial" };
    return { kind: "other" };
  }
  if (host === "myaccount.google.com") return { kind: "myaccount" };
  // Post-sign-in prompts ("confirm your recovery info", "add a home address"):
  // the session already exists; the account page is one navigation away.
  if (host === "gds.google.com") return { kind: "interstitial" };
  return { kind: "other" };
}

/** One word-ish reason: no page text, no spaces beyond the slug and a path. */
export function slug(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Stdin, exactly: `ux-test` already dropped the file's one trailing newline. */
async function readPassword(): Promise<string> {
  return await new Response(Deno.stdin.readable).text();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function snapshot(page: Page, account: string): Promise<Snapshot | null> {
  try {
    const dom = await page.evaluate((acct: string) => {
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none";
      };
      const any = (selector: string) =>
        Array.from(document.querySelectorAll(selector)).some(visible);
      const lower = acct.toLowerCase();
      return {
        text: (document.body?.innerText ?? "").slice(0, 4000),
        hasIdentifier: any('input[type="email"], #identifierId'),
        hasPassword: any('input[type="password"]'),
        chooserHasAccount: Array.from(
          document.querySelectorAll("[data-identifier], [data-email]"),
        ).some(
          (el) =>
            (
                el.getAttribute("data-identifier") ??
                  el.getAttribute("data-email") ??
                  ""
              ).toLowerCase() === lower && visible(el),
        ),
        hasCaptcha: any("#captchaimg"),
        accountInPage: document.documentElement.innerHTML.toLowerCase()
          .includes(lower),
      };
    }, account);
    return { url: page.url(), ...dom };
  } catch {
    // Mid-navigation: the context went away under the evaluate.
    return null;
  }
}

/** Tag the first visible element matching `selector`, so a trusted CDP click or
 *  `page.type` can target exactly it. With `label`, only an enabled element
 *  whose whole visible text is `label` (any case) counts, and it must be the
 *  only one: an ambiguous page tags nothing. */
async function tag(
  page: Page,
  selector: string,
  name: string,
  label: string | null = null,
): Promise<boolean> {
  return await page.evaluate(
    (sel: string, id: string, want: string | null) => {
      for (
        const el of Array.from(document.querySelectorAll("[data-ux-signin]"))
      ) {
        el.removeAttribute("data-ux-signin");
      }
      const candidates = Array.from(document.querySelectorAll(sel)).filter(
        (el) => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (!(rect.width > 0 && rect.height > 0)) return false;
          if (want === null) return true;
          const text = ((el as HTMLElement).innerText ?? "").trim();
          return text.toLowerCase() === want.toLowerCase() &&
            !(el as HTMLButtonElement).disabled &&
            el.getAttribute("aria-disabled") !== "true";
        },
      );
      // A labelled match nested in another (a role=button wrapping its
      // <button>) is one control: keep the innermost.
      const targets = want === null
        ? candidates
        : candidates.filter((el) =>
          !candidates.some((other) => other !== el && el.contains(other))
        );
      if (targets.length === 0) return false;
      if (want !== null && targets.length !== 1) return false;
      targets[0].setAttribute("data-ux-signin", id);
      return true;
    },
    selector,
    name,
    label,
  );
}

/** Empty every password input, then report whether any still holds a value. */
async function passwordFieldsEmpty(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const inputs = Array.from(
        document.querySelectorAll('input[type="password"]'),
      );
      for (const input of inputs) (input as HTMLInputElement).value = "";
      return inputs.every((input) => (input as HTMLInputElement).value === "");
    });
  } catch {
    return false;
  }
}

type Outcome = { line: string; code: number };

async function needsHuman(
  page: Page,
  outDir: string,
  reason: string,
): Promise<Outcome> {
  const why = slug(reason);
  // Never a screenshot while a password field holds a value.
  if (await passwordFieldsEmpty(page)) {
    const name = why.split(" ")[0].replace(/[^a-z0-9_-]/gi, "_");
    try {
      // A tab that is not in front can wait forever for a frame; bound it.
      await page.bringToFront();
      await Promise.race([
        page.screenshot({
          path: `${outDir}/google-signin-${name}.png`,
          captureBeyondViewport: false,
        }),
        sleep(10_000).then(() => {
          throw new Error("no frame within 10s");
        }),
      ]);
    } catch (error) {
      // The status line is the result; a missing screenshot is not. The page
      // holds no password here (checked above), so its error may be logged.
      console.error(
        `screenshot failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  } else {
    console.error("no screenshot: a password field could not be emptied");
  }
  return { line: `google-signin: needs-human ${why}`, code: EXIT_NEEDS_HUMAN };
}

function where(url: string): string {
  const parsed = parse(url);
  return parsed ? `${parsed.hostname}${parsed.pathname}` : "unknown-page";
}

async function signIn(
  page: Page,
  account: string,
  password: string,
  outDir: string,
): Promise<Outcome> {
  const deadline = Date.now() + DEADLINE_MS;
  await page.goto(signinUrl(account), {
    waitUntil: "domcontentloaded",
    timeout: DEADLINE_MS,
  });

  let typedPassword = false;
  let typedEmail = false;
  let chooserClicks = 0;
  let reauthClicks = 0;
  let myaccountVisits = 0;
  let last = { key: "", since: Date.now() };
  let state: State = { kind: "other" };

  while (Date.now() < deadline) {
    const snap = await snapshot(page, account);
    if (!snap) {
      await sleep(POLL_MS);
      continue;
    }
    state = classify(snap, typedPassword);
    const key = `${state.kind} ${where(snap.url)}`;
    if (key !== last.key) last = { key, since: Date.now() };
    const stuck = Date.now() - last.since > STUCK_MS;

    switch (state.kind) {
      case "needs-human":
        return await needsHuman(page, outDir, state.reason);
      case "myaccount":
        if (!snap.accountInPage) {
          // Signed in, but not provably as `account` (another default account).
          if (!stuck) break;
          return await needsHuman(page, outDir, "wrong-account");
        }
        return {
          line: `google-signin: ${
            typedPassword ? "signed-in" : "already-signed-in"
          }`,
          code: EXIT_OK,
        };
      case "password":
        if (typedPassword) {
          if (stuck) {
            return await needsHuman(page, outDir, "password-not-accepted");
          }
          break;
        }
        if (!(await tag(page, 'input[type="password"]', "pwd"))) break;
        try {
          await page.type('[data-ux-signin="pwd"]', password, { delay: 40 });
          await page.keyboard.press("Enter");
        } catch {
          // Deliberately no detail: nothing about the input's value may leave.
          return {
            line: "google-signin: error typing into the password field failed",
            code: EXIT_ERROR,
          };
        }
        typedPassword = true;
        last = { key: "", since: Date.now() };
        break;
      case "identifier":
        if (typedEmail) {
          if (stuck) {
            return await needsHuman(page, outDir, "identifier-not-accepted");
          }
          break;
        }
        if (!(await tag(page, 'input[type="email"], #identifierId', "email"))) {
          break;
        }
        try {
          // Select whatever the field holds, so typing replaces it.
          await page.evaluate(() => {
            const input = document.querySelector<HTMLInputElement>(
              '[data-ux-signin="email"]',
            );
            input?.focus();
            input?.select();
          });
          await page.type('[data-ux-signin="email"]', account, { delay: 30 });
          await page.keyboard.press("Enter");
        } catch {
          // The page moved under us; the next poll looks again.
          if (stuck) {
            return await needsHuman(page, outDir, "identifier-not-typeable");
          }
          break;
        }
        typedEmail = true;
        last = { key: "", since: Date.now() };
        break;
      case "chooser":
        if (chooserClicks >= 2) {
          return await needsHuman(page, outDir, "chooser-stuck");
        }
        if (
          !(await tag(
            page,
            `[data-identifier="${account}" i], [data-email="${account}" i]`,
            "account",
          ))
        ) {
          break;
        }
        await page.click('[data-ux-signin="account"]');
        chooserClicks += 1;
        last = { key: "", since: Date.now() };
        break;
      case "reauth":
        // One Next, ever: if the page still asks after STUCK_MS (or never
        // offers exactly one enabled Next), it is a human's.
        if (reauthClicks >= 1) {
          if (stuck) return await needsHuman(page, outDir, "verify-its-you");
          break;
        }
        if (!(await tag(page, 'button, [role="button"]', "next", "Next"))) {
          if (stuck) return await needsHuman(page, outDir, "verify-its-you");
          break;
        }
        // Counted before the click, so a click that throws is never retried.
        reauthClicks += 1;
        try {
          await page.click('[data-ux-signin="next"]');
        } catch {
          // The page moved under us; the next poll looks again.
        }
        last = { key: "", since: Date.now() };
        break;
      case "interstitial":
        if (myaccountVisits >= 1) {
          if (stuck) {
            return await needsHuman(
              page,
              outDir,
              `interstitial ${where(snap.url)}`,
            );
          }
          break;
        }
        myaccountVisits += 1;
        await page.goto(continueUrl(account), {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        last = { key: "", since: Date.now() };
        break;
      case "other":
        if (stuck) {
          return await needsHuman(
            page,
            outDir,
            `unknown-page ${where(snap.url)}`,
          );
        }
        break;
    }
    await sleep(POLL_MS);
  }
  return {
    line: `google-signin: timeout ${slug(state.kind)} ${where(page.url())}`,
    code: EXIT_ERROR,
  };
}

async function main(): Promise<number> {
  // Before anything else, and synchronously: ux-test retries a run that died
  // on SIGSEGV/SIGBUS with an empty log (deno 2.7.14's startup crash), and
  // this line makes sure any run that reached the script leaves a log.
  console.error("google-signin.deno.ts started");
  const [browserURL, account, outDir] = Deno.args;
  if (!browserURL || !account || !outDir) {
    console.error(
      "usage: google-signin.deno.ts <devtools-url> <account> <out-dir> < password",
    );
    console.log("google-signin: error usage");
    return EXIT_USAGE;
  }
  const password = await readPassword();
  if (password.length === 0) {
    console.log("google-signin: error no password on stdin");
    return EXIT_USAGE;
  }

  let browser: Browser | null = null;
  let page: Page | null = null;
  let outcome: Outcome;
  try {
    browser = await puppeteer.connect({
      browserURL,
      defaultViewport: null,
      // No single DevTools call may outlive the pre-step's own deadline.
      protocolTimeout: 30_000,
    });
    // The profile's service-worker targets come up before its first page.
    await browser.waitForTarget((target) => target.type() === "page", {
      timeout: 30_000,
    });
    page = await browser.newPage();
    outcome = await signIn(page, account, password, outDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An error never carries the password: it is only ever an argument to
    // `page.type`, whose failures are caught above without their message.
    outcome = {
      line: `google-signin: error ${slug(message)}`,
      code: EXIT_ERROR,
    };
  } finally {
    // Only this tab: the browser belongs to ux-test.
    await page?.close().catch(() => {});
    await browser?.disconnect().catch(() => {});
  }
  console.log(outcome.line);
  return outcome.code;
}

if (import.meta.main) {
  Deno.exit(await main());
}
