import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { switchModule } from "../../vendor/tento/tento-web-js/build-plugins/build-switch.deno.ts";
import { hostedBadge } from "./hosted-badge.ts";
import copy from "./hosted-badge.switched.ts";

const SWITCHED = new URL("./hosted-badge.switched.ts", import.meta.url).pathname;
// A site directory with no .env, so only the given process value decides.
const NO_ENV = new URL("./no-such-site-dir", import.meta.url).pathname;

async function build(processValue: string | undefined) {
  const source = await Deno.readTextFile(SWITCHED);
  return await switchModule(NO_ENV, SWITCHED, source, (name) => {
    assertEquals(name, "AUTOPHYS_HOSTED_BADGE");
    return processValue;
  });
}

Deno.test("AUTOPHYS_HOSTED_BADGE=on bundles the pill's copy and link as written", async () => {
  for (const value of ["on", "1", "true"]) {
    const { on, contents } = await build(value);
    assert(on, value);
    assertStringIncludes(contents, copy!.text);
    assertStringIncludes(contents, copy!.href);
  }
});

Deno.test("with AUTOPHYS_HOSTED_BADGE off or unset the build bundles null and none of the pill's copy", async () => {
  for (const value of ["off", "0", "", undefined]) {
    const { on, contents } = await build(value);
    assert(!on, String(value));
    assertStringIncludes(contents, "export default null;");
    assert(!contents.includes(copy!.text) && !contents.includes(copy!.href), String(value));
  }
});

Deno.test("the pill renders nowhere when the build left its copy out", () => {
  assertEquals(hostedBadge(null), null);
});
