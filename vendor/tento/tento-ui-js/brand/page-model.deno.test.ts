import { assertEquals } from "jsr:@std/assert";
import { PageModel } from "./page-model.ts";

Deno.test("PageModel.parse round-trips the shared fixture", async () => {
  const fixtureUrl = new URL("./page-model.fixture.json", import.meta.url);
  const fixture = JSON.parse(await Deno.readTextFile(fixtureUrl));
  const parsed = PageModel.parse(JSON.parse(await Deno.readTextFile(fixtureUrl)));

  assertEquals(JSON.parse(JSON.stringify(parsed)), fixture);
  assertEquals(parsed.route, "/blog");
  assertEquals(parsed.nodes[0].kind, "hero");
  assertEquals(parsed.nodes[1].children?.[0].kind, "card");
});
