// Headless Chrome that cannot outlive the script that launched it.
//
// puppeteer's default transport is a websocket: when a script throws before
// `browser.close()`, Deno exits and Chrome is re-parented to launchd, where it
// keeps running for days. With `pipe: true` the DevTools channel is Chrome's
// own stdio, so the browser exits as soon as its owner does, however the owner
// ends. `launchHeadless` always launches that way; `withHeadless` also closes
// the browser in a `finally`, for long-lived owners that survive an error.
//
//   import { withHeadless } from "@tento-headless";            // in the tento repo
//   import { withHeadless } from "file://<tento>/tento-headless-js/mod.ts";  // elsewhere
//   await withHeadless(async (browser) => { … });
//
// The executable is `executablePath`, else $TENTO_HEADLESS_CHROME, else the
// newest chrome-headless-shell under ~/.cache/puppeteer, else the newest
// Chrome for Testing there. The headless shell is preferred because full
// Chrome needs the macOS GUI session: started over ssh it crashes or hangs at
// launch (rwc-01, CfT 124 and 152), while the shell starts anywhere. Without a
// `userDataDir`, the profile is a temp dir removed once Chrome disconnects
// (puppeteer's own removal races Chrome's helpers under Deno: ENOTEMPTY).

import puppeteer, { type Browser, type PuppeteerLaunchOptions } from "npm:puppeteer-core@22.7.1";

const CLOSE_BOUND_MS = 20_000;

export async function launchHeadless(options: PuppeteerLaunchOptions = {}): Promise<Browser> {
  const executablePath = options.executablePath ?? await findChrome();
  const shell = executablePath.endsWith("chrome-headless-shell");
  const profile = options.userDataDir ? undefined : await Deno.makeTempDir({ prefix: "tento-headless-" });
  // Deno does not count reads on Chrome's pipe as pending work, so without a
  // ref'd timer it can exit mid-launch ("Top-level await promise never resolved").
  const keepAlive = setInterval(() => {}, 60_000);
  let browser: Browser;
  try {
    browser = await puppeteer.launch({
      headless: shell ? "shell" : true,
      // A loaded shared host can take a minute to start Chrome.
      timeout: 180_000,
      protocolTimeout: 180_000,
      ...options,
      executablePath,
      userDataDir: options.userDataDir ?? profile,
      pipe: true,
    });
  } catch (error) {
    clearInterval(keepAlive);
    if (profile) await removeProfile(profile);
    throw error;
  }
  browser.once("disconnected", () => {
    clearInterval(keepAlive);
    if (profile) void removeProfile(profile);
  });
  return browser;
}

/** `browser.close()`, bounded; a browser still running after the bound is killed. */
export async function closeHeadless(browser: Browser, boundMs = CLOSE_BOUND_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([browser.close(), new Promise((resolve) => (timer = setTimeout(resolve, boundMs)))]);
  } finally {
    clearTimeout(timer);
    const proc = browser.process();
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill("SIGKILL");
  }
}

export async function withHeadless<T>(run: (browser: Browser) => Promise<T>, options?: PuppeteerLaunchOptions): Promise<T> {
  const browser = await launchHeadless(options);
  let result: T;
  try {
    result = await run(browser);
  } catch (error) {
    // the body's failure is the one worth reporting; a close failure must not replace it
    await closeHeadless(browser).catch(() => {});
    throw error;
  }
  await closeHeadless(browser);
  return result;
}

async function removeProfile(dir: string): Promise<void> {
  // Chrome's helper processes can still be writing for a moment after exit.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await Deno.remove(dir, { recursive: true });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

const BINARIES: Record<string, string[]> = {
  "chrome-headless-shell": [
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
    "chrome-headless-shell-linux64/chrome-headless-shell",
  ],
  chrome: [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-linux64/chrome",
  ],
};

/** The executable `launchHeadless` uses without `executablePath`; rejects when there is none. */
export async function findChrome(): Promise<string> {
  const env = Deno.env.get("TENTO_HEADLESS_CHROME");
  if (env) return env;
  const cache = `${Deno.env.get("HOME")}/.cache/puppeteer`;
  for (const [kind, binaries] of Object.entries(BINARIES)) {
    const builds: string[] = [];
    try {
      for await (const entry of Deno.readDir(`${cache}/${kind}`)) if (entry.isDirectory) builds.push(entry.name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    builds.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const build of builds) {
      for (const binary of binaries) {
        const path = `${cache}/${kind}/${build}/${binary}`;
        try {
          if ((await Deno.stat(path)).isFile) return path;
        } catch {
          // not this platform's build
        }
      }
    }
  }
  throw new Error(`no Chrome under ${cache}; pass executablePath or set TENTO_HEADLESS_CHROME`);
}
