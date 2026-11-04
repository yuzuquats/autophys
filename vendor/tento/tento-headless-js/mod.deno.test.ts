// Launches real Chrome; ignored only where no Chrome is installed, so a launch
// that fails is a failure, not a skip.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { findChrome, withHeadless } from "./mod.ts";

const chrome = await findChrome().then(() => true, () => false);

function running(pid: number): boolean {
  return new Deno.Command("ps", { args: ["-p", String(pid)], stdout: "null" }).outputSync().success;
}

async function gone(pid: number, withinMs = 10_000): Promise<boolean> {
  for (const deadline = Date.now() + withinMs; Date.now() < deadline;) {
    if (!running(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

Deno.test({
  name: "a script that throws after launching leaves no Chrome behind",
  ignore: !chrome,
  async fn() {
    const script = await Deno.makeTempFile({ suffix: ".ts" });
    try {
      await Deno.writeTextFile(script, `
        import { launchHeadless } from ${JSON.stringify(new URL("./mod.ts", import.meta.url).href)};
        const browser = await launchHeadless();
        await (await browser.newPage()).goto("about:blank");
        console.log(browser.process()!.pid);
        throw new Error("the script fails before it closes its browser");
      `);
      const out = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", script], stdout: "piped", stderr: "null" }).output();
      assert(!out.success, "the script was meant to fail");
      const pid = Number(new TextDecoder().decode(out.stdout).trim());
      assert(pid > 0, "the script did not report its Chrome");
      assert(await gone(pid), `Chrome ${pid} outlived the script that launched it`);
    } finally {
      await Deno.remove(script);
    }
  },
});

Deno.test({
  name: "withHeadless closes the browser when the body throws",
  ignore: !chrome,
  async fn() {
    let pid = 0;
    await assertRejects(() =>
      withHeadless(async (browser) => {
        pid = browser.process()!.pid!;
        throw new Error("body failed");
      }), Error, "body failed");
    assert(pid > 0);
    assertEquals(running(pid), false);
  },
});
