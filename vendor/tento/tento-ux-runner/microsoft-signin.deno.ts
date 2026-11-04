// Microsoft sign-in pre-step for agent-driven `ux-test run --auto`.
//
// The Microsoft twin of `google-signin.deno.ts`, with the same contract.
// `tento-ux-test` (src/agent.rs) runs it against the run's own browser — the
// tester's persistent profile, on a private DevTools port the agent is never
// told — BEFORE the browser the agent drives is started, so the agent inherits
// a live Microsoft session: an app's "Connect Outlook" / "Reconnect" then needs
// at most an account tile and a consent Accept, never a password. The Rust side
// embeds this file (`include_str!`) and writes it beside the run, so the script
// always matches the binary that runs it.
//
//   deno run --no-prompt --cached-only --config <runner>/deno.json \
//     --allow-net=127.0.0.1:<port> --allow-read=<out> --allow-write=<out> --allow-env \
//     microsoft-signin.deno.ts <devtools-url> <account> <out-dir> <app-url> < password
//
// The password arrives on STDIN only, byte for byte. It is never printed,
// logged, written, or passed anywhere but the focused password input, and no
// screenshot is taken while a password field holds a value.
//
// The script drives exactly four kinds of screen: the account (email) entry or
// the account picker, the password, "Stay signed in?", and a consent page.
// ANYTHING else Microsoft shows — a code or authenticator prompt, "Help us
// protect your account", a CAPTCHA or puzzle, a lock, a page it does not know —
// ends the step with `challenge <reason>` and a screenshot. It never answers a
// challenge and never picks another sign-in method in its place: that is the
// operator's step.
//
// Exactly one status line goes to stdout, last:
//   microsoft-signin: already-signed-in          exit 0
//   microsoft-signin: signed-in                  exit 0
//   microsoft-signin: challenge <reason>         exit 3  (screenshot in <out-dir>)
//   microsoft-signin: timeout <state>            exit 1
//   microsoft-signin: error <reason>             exit 1
//
// No user-agent override, no stealth, no Emulation.*: a provider that refuses
// this browser is a result, not a thing to evade.

import { appSigninUrl, oauthRedirectForStart } from "./microsoft-oauth-start.ts";
import puppeteer from "npm:puppeteer-core@22.7.1";
import type { Browser, Page } from "npm:puppeteer-core@22.7.1";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_CHALLENGE = 3;

/** The whole pre-step's budget. The Rust side kills the process a little later. */
const DEADLINE_MS = 75_000;
/** How long an unrecognised page may sit still before it is the operator's. */
const STUCK_MS = 20_000;
const POLL_MS = 500;

/** Consumer cookies alone never prove that the app's OAuth flow is ready. */
export const ACCOUNT_HOME = "https://login.live.com/";

/** What one poll of the sign-in tab saw. Never carries an input's value. */
export type Snapshot = {
  url: string;
  /** Visible body text, truncated. */
  text: string;
  /** An email / account-name field is visible. */
  hasEmail: boolean;
  hasPassword: boolean;
  /** The account picker shows a tile for `account`. */
  tileHasAccount: boolean;
  /** A visible "Sign in" control (the signed-out account page). */
  hasSigninControl: boolean;
  /** A visible consent Accept button. */
  hasConsentAccept: boolean;
  /** A CAPTCHA / puzzle frame is on the page. */
  hasCaptcha: boolean;
  /** The page's markup names `account` (the signed-in account page does). */
  accountInPage: boolean;
  /** Server-rendered Outlook callback result, never an input value. */
  oauthSuccess?: boolean;
  oauthFailure?: boolean;
};

export type State =
  | { kind: "oauth-signed-in" }
  | { kind: "email" }
  | { kind: "picker" }
  | { kind: "password" }
  | { kind: "stay-signed-in" }
  | { kind: "consent" }
  | { kind: "challenge"; reason: string }
  | { kind: "other" };

const MICROSOFT_LOGIN_HOSTS = new Set([
  "login.live.com",
  "login.microsoftonline.com",
  "login.microsoft.com",
  "account.live.com",
  "signup.live.com",
]);

/** Phrases that mean Microsoft wants more than a password. Checked against the
 *  visible text of every page that is not a password page. */
const CHALLENGES: [RegExp, string][] = [
  [/help us protect your account/i, "protect-your-account"],
  [/help us secure your account/i, "protect-your-account"],
  [
    /verify your identity|confirm your identity|we need to verify/i,
    "verify-identity",
  ],
  [/verify your email|verify your phone/i, "verify-identity"],
  [
    /enter (the )?code|we.ve sent (a|you a) code|sent a code to|get a code/i,
    "code",
  ],
  [
    /authenticator app|approve (the |your )?sign.?in request|approve sign.?in/i,
    "authenticator",
  ],
  [/add security info|security info/i, "security-info"],
  [
    /solve (the|this) puzzle|prove you.re not a robot|press and hold/i,
    "captcha",
  ],
  [/account (has been |is )?(locked|blocked|suspended)/i, "locked"],
  [/too many (requests|attempts)/i, "rate-limited"],
  [/(doesn.t|does not) exist|couldn.t find an account/i, "unknown-account"],
];

/** Phrases that mean another sign-in method is being offered INSTEAD of the
 *  four screens this script drives. Checked last: the account entry page links
 *  "Sign-in options" too, and that page is driven, not a challenge. */
const OTHER_METHODS: [RegExp, string][] = [
  [/security key|windows hello|use your face, fingerprint|passkey/i, "passkey"],
  [
    /sign.?in options|other ways to sign in|sign in another way/i,
    "other-method",
  ],
];

/** Paths under Microsoft's account hosts that are always a challenge. */
const CHALLENGE_PATHS: [RegExp, string][] = [
  [/\/proofs\//i, "proofs"],
  [/\/recover/i, "recover"],
  [/\/abuse/i, "abuse"],
  [/\/identity\/confirm/i, "identity-confirm"],
];

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Decide what the tab is showing. Pure, so it is tested without a browser. */
export function classify(
  snap: Snapshot,
  typedPassword: boolean,
  oauthRedirect?: string,
): State {
  const url = parse(snap.url);
  const host = url?.hostname ?? "";
  const path = url?.pathname ?? "";
  const text = snap.text;

  if (snap.hasCaptcha) return { kind: "challenge", reason: "captcha" };
  const redirect = oauthRedirect ? parse(oauthRedirect) : null;
  if (
    redirect && url?.origin === redirect.origin && path === redirect.pathname
  ) {
    if (snap.oauthFailure || url.searchParams.has("error")) {
      return { kind: "challenge", reason: "oauth-failed" };
    }
    if (snap.oauthSuccess) return { kind: "oauth-signed-in" };
    return { kind: "other" };
  }
  if (!MICROSOFT_LOGIN_HOSTS.has(host)) return { kind: "other" };

  if (snap.hasPassword) {
    if (
      typedPassword &&
      /password is incorrect|incorrect password|account or password is incorrect/i
        .test(text)
    ) {
      return { kind: "challenge", reason: "wrong-password" };
    }
    return { kind: "password" };
  }
  for (const [pattern, reason] of CHALLENGE_PATHS) {
    if (pattern.test(path)) {
      return { kind: "challenge", reason: `path-${reason}` };
    }
  }
  for (const [pattern, reason] of CHALLENGES) {
    if (pattern.test(text)) return { kind: "challenge", reason };
  }
  if (/stay signed in\?/i.test(text) || /kmsi/i.test(path)) {
    return { kind: "stay-signed-in" };
  }
  if (snap.hasConsentAccept) return { kind: "consent" };
  if (snap.tileHasAccount) return { kind: "picker" };
  if (snap.hasEmail) return { kind: "email" };
  for (const [pattern, reason] of OTHER_METHODS) {
    if (pattern.test(text)) return { kind: "challenge", reason };
  }
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

/** The Accept on Microsoft's consent pages, old and new. */
export const CONSENT_ACCEPT =
  '#idBtn_Accept, #acceptButton, [data-testid="appConsentPrimaryButton"]';
/** The primary ("Yes" / "Next" / "Sign in") button, old and new pages. */
export const PRIMARY_BUTTON = '#idSIButton9, [data-testid="primaryButton"]';
export const EMAIL_INPUT =
  'input[type="email"], input[name="loginfmt"], #i0116, #usernameEntry';

async function snapshot(page: Page, account: string): Promise<Snapshot | null> {
  try {
    const dom = await page.evaluate(
      (acct: string, consent: string, email: string) => {
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
        const short = (el: Element) =>
          ((el as HTMLElement).innerText ?? "").trim().toLowerCase();
        return {
          text: (document.body?.innerText ?? "").slice(0, 4000),
          hasEmail: any(email),
          hasPassword: any('input[type="password"]'),
          tileHasAccount: Array.from(
            document.querySelectorAll(
              '[data-test-id], [role="button"], [role="listitem"], button',
            ),
          ).some((el) =>
            visible(el) &&
            ((el.getAttribute("data-test-id") ?? "").toLowerCase() === lower ||
              (short(el).length < 200 && short(el).includes(lower)))
          ),
          hasSigninControl: Array.from(
            document.querySelectorAll("a, button"),
          ).some((el) => visible(el) && /^sign in$/i.test(short(el))),
          hasConsentAccept: any(consent),
          hasCaptcha: any(
            '#enforcementFrame, #hipEnforcementContainer, iframe[src*="arkose"], iframe[src*="hsprotect"], iframe[title*="captcha" i]',
          ),
          accountInPage: document.documentElement.innerHTML.toLowerCase()
            .includes(lower),
          oauthSuccess: Array.from(document.scripts).some((script) =>
            script.textContent?.includes("type: 'outlook-auth-success'")
          ),
          oauthFailure: Array.from(document.scripts).some((script) =>
            script.textContent?.includes("type: 'outlook-auth-failure'")
          ),
        };
      },
      account,
      CONSENT_ACCEPT,
      EMAIL_INPUT,
    );
    return { url: page.url(), ...dom };
  } catch {
    // Mid-navigation: the context went away under the evaluate.
    return null;
  }
}

/** Tag the first visible element matching `selector` (and, when given, whose
 *  text matches `textPattern` or whose data-test-id is `testId`), so a trusted
 *  CDP click or `page.type` can target exactly it. */
async function tag(
  page: Page,
  selector: string,
  name: string,
  match: { text?: string; account?: string } = {},
): Promise<boolean> {
  return await page.evaluate(
    (sel: string, id: string, text: string, acct: string) => {
      for (
        const el of Array.from(document.querySelectorAll("[data-ux-signin]"))
      ) {
        el.removeAttribute("data-ux-signin");
      }
      const pattern = text ? new RegExp(text, "i") : null;
      const lower = acct.toLowerCase();
      const target = Array.from(document.querySelectorAll(sel)).find((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return false;
        const own = ((el as HTMLElement).innerText ?? "").trim();
        if (pattern && !pattern.test(own)) return false;
        if (
          lower &&
          (el.getAttribute("data-test-id") ?? "").toLowerCase() !== lower &&
          !(own.length < 200 && own.toLowerCase().includes(lower))
        ) {
          return false;
        }
        return true;
      });
      if (!target) return false;
      target.setAttribute("data-ux-signin", id);
      return true;
    },
    selector,
    name,
    match.text ?? "",
    match.account ?? "",
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
      (document.activeElement as HTMLElement | null)?.blur?.();
      return inputs.every((input) => (input as HTMLInputElement).value === "");
    });
  } catch {
    return false;
  }
}

type Outcome = { line: string; code: number };

async function challenge(
  page: Page,
  outDir: string,
  reason: string,
): Promise<Outcome> {
  const why = slug(reason);
  // Never a screenshot while a password field holds a value.
  if (await passwordFieldsEmpty(page)) {
    const name = why.split(" ")[0].replace(/[^a-z0-9_-]/gi, "_");
    try {
      // Record visible body text under the same emptied-password guard.
      const text = await page.evaluate(() =>
        (document.body?.innerText ?? "").slice(0, 4000)
      );
      await Deno.writeTextFile(
        outDir + "/microsoft-signin-" + name + ".txt",
        text,
      );
      // A tab that is not in front can wait forever for a frame; bound it.
      await page.bringToFront();
      await Promise.race([
        page.screenshot({
          path: `${outDir}/microsoft-signin-${name}.png`,
          captureBeyondViewport: false,
        }),
        sleep(10_000).then(() => {
          throw new Error("no frame within 10s");
        }),
      ]);
    } catch (error) {
      // The page holds no password here (checked above), so its error may be
      // logged.
      console.error(
        `screenshot failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  } else {
    console.error("no screenshot: a password field could not be emptied");
  }
  return { line: `microsoft-signin: challenge ${why}`, code: EXIT_CHALLENGE };
}

function where(url: string): string {
  const parsed = parse(url);
  return parsed ? `${parsed.hostname}${parsed.pathname}` : "unknown-page";
}

async function clickTagged(page: Page, name: string): Promise<void> {
  await page.click(`[data-ux-signin="${name}"]`);
}

/** Capture the real app handler's OAuth URL, then use this private tab.
 * Client id, scopes, redirect URI and select_account come from the app.
 * No untracked popup can hold a password. */
async function oauthStart(page: Page, appUrl: string): Promise<string> {
  await page.goto(appSigninUrl(appUrl), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForFunction(
    () =>
      typeof (document.getElementById("microsoft-signin") as
        | HTMLElement & { onPress?: unknown }
        | null)?.onPress === "function",
    { timeout: 20_000 },
  );
  const value = await page.evaluate(async () => {
    const button = document.getElementById("microsoft-signin") as
      & HTMLElement
      & { onPress: () => Promise<void> };
    const original = window.open;
    let captured = "";
    window.open = (url) => {
      captured = String(url ?? "");
      return { closed: false } as Window;
    };
    try {
      await button.onPress();
    } finally {
      window.open = original;
    }
    return captured;
  });
  oauthRedirectForStart(value, appUrl);
  return value;
}

async function signIn(
  page: Page,
  account: string,
  password: string,
  outDir: string,
  appUrl: string,
): Promise<Outcome> {
  const deadline = Date.now() + DEADLINE_MS;
  const start = await oauthStart(page, appUrl);
  const redirect = oauthRedirectForStart(start, appUrl);
  await page.goto(start, {
    waitUntil: "domcontentloaded",
    timeout: DEADLINE_MS,
  });

  let typedPassword = false;
  let typedEmail = false;
  let pickerClicks = 0;
  let staySignedInClicks = 0;
  let consentClicks = 0;
  let last = { key: "", since: Date.now() };
  let state: State = { kind: "other" };

  const fresh = () => {
    last = { key: "", since: Date.now() };
  };

  while (Date.now() < deadline) {
    const snap = await snapshot(page, account);
    if (!snap) {
      await sleep(POLL_MS);
      continue;
    }
    state = classify(snap, typedPassword, redirect);
    const key = `${state.kind} ${where(snap.url)}`;
    if (key !== last.key) last = { key, since: Date.now() };
    const stuck = Date.now() - last.since > STUCK_MS;

    switch (state.kind) {
      case "challenge":
        return await challenge(page, outDir, state.reason);
      case "oauth-signed-in":
        return {
          line: typedPassword || typedEmail
            ? "microsoft-signin: signed-in"
            : "microsoft-signin: already-signed-in",
          code: EXIT_OK,
        };
      case "password":
        if (typedPassword) {
          if (stuck) {
            return await challenge(page, outDir, "password-not-accepted");
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
            line:
              "microsoft-signin: error typing into the password field failed",
            code: EXIT_ERROR,
          };
        }
        typedPassword = true;
        fresh();
        break;
      case "email":
        if (typedEmail) {
          if (stuck) {
            return await challenge(page, outDir, "account-not-accepted");
          }
          break;
        }
        if (!(await tag(page, EMAIL_INPUT, "email"))) break;
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
            return await challenge(page, outDir, "account-not-typeable");
          }
          break;
        }
        typedEmail = true;
        fresh();
        break;
      case "picker":
        // An account tile in the app OAuth flow is the agent-ready screen.
        if (!typedEmail && !typedPassword) {
          return { line: "microsoft-signin: already-signed-in", code: EXIT_OK };
        }
        if (pickerClicks >= 2) {
          return await challenge(page, outDir, "picker-stuck");
        }
        if (
          !(await tag(
            page,
            '[data-test-id], [role="button"], [role="listitem"], button',
            "account",
            { account },
          ))
        ) {
          break;
        }
        await clickTagged(page, "account");
        pickerClicks += 1;
        fresh();
        break;
      case "stay-signed-in":
        // "Yes": the session must outlive this browser, so the agent's browser
        // opens the profile already signed in.
        if (staySignedInClicks >= 2) {
          return await challenge(page, outDir, "stay-signed-in-stuck");
        }
        if (!(await tag(page, PRIMARY_BUTTON, "yes"))) {
          if (
            !(await tag(page, "button, input[type=submit]", "yes", {
              text: "^yes$",
            }))
          ) {
            if (stuck) {
              return await challenge(page, outDir, "stay-signed-in-no-yes");
            }
            break;
          }
        }
        await clickTagged(page, "yes");
        staySignedInClicks += 1;
        fresh();
        break;
      case "consent":
        if (consentClicks >= 1) {
          if (stuck) return await challenge(page, outDir, "consent-stuck");
          break;
        }
        if (!(await tag(page, CONSENT_ACCEPT, "accept"))) break;
        await clickTagged(page, "accept");
        consentClicks += 1;
        fresh();
        break;
      case "other":
        if (!stuck) break;
        return await challenge(page, outDir, `unknown-page ${where(snap.url)}`);
    }
    await sleep(POLL_MS);
  }
  return {
    line: `microsoft-signin: timeout ${slug(state.kind)} ${where(page.url())}`,
    code: EXIT_ERROR,
  };
}

async function main(): Promise<number> {
  // Before anything else, and synchronously: ux-test retries a run that died
  // on SIGSEGV/SIGBUS with an empty log (deno 2.7.14's startup crash), and
  // this line makes sure any run that reached the script leaves a log.
  console.error("microsoft-signin.deno.ts started");
  const [browserURL, account, outDir, appUrl] = Deno.args;
  if (!browserURL || !account || !outDir || !appUrl) {
    console.error(
      "usage: microsoft-signin.deno.ts <devtools-url> <account> <out-dir> <app-url> < password",
    );
    console.log("microsoft-signin: error usage");
    return EXIT_USAGE;
  }
  const password = await readPassword();
  if (password.length === 0) {
    console.log("microsoft-signin: error no password on stdin");
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
    // The callback calls window.close(); keep this private tab alive until its
    // server-rendered result has been classified, then close it in finally.
    await page.evaluateOnNewDocument(() => {
      window.close = () => {};
    });
    outcome = await signIn(page, account, password, outDir, appUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An error never carries the password: it is only ever an argument to
    // `page.type`, whose failures are caught above without their message.
    outcome = {
      line: `microsoft-signin: error ${slug(message)}`,
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
