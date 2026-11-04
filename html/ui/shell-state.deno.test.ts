import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { mainMarkup } from "./main.ts";
import { detailsMarkup } from "./details.ts";
import { breadcrumbText } from "./breadcrumb.ts";
import { derive, connectionFailure } from "../client/derive/index.ts";
import { initialSelection } from "../client/controller.ts";
import { fixtures } from "../client/fixtures/source.ts";
import { autophysStyles } from "./styles.ts";

Deno.test("shell: reconnect notice appears once above retained content with one live region", async () => {
  const snap = await fixtures([]).load(), selection = initialSelection(snap.workspace);
  for (const loaded of [false, true]) {
    const view = connectionFailure(derive(loaded ? snap : null, selection), "Lost connection <offline>", loaded);
    const main = mainMarkup(view.main, 640);
    const html = main + detailsMarkup(view.details);
    assertEquals((html.match(/Connection unavailable/g) ?? []).length, 1);
    assertEquals((html.match(/Lost connection/g) ?? []).length, 1);
    assertEquals((main.match(/role="status"/g) ?? []).length, 1);
    assertStringIncludes(main, 'class="ap-connection" role="status"');
    assertStringIncludes(main, "Lost connection &lt;offline&gt;");
    assertEquals((html.match(/data-ap-button="retry"/g) ?? []).length, 1);
    assertEquals(main.indexOf('class="ap-connection"') < main.indexOf('class="ap-viewer'), true);
  }
});

Deno.test("shell: breadcrumbs share spaced separators and preserve full long names", () => {
  const crumb = [{ label: "A very long investigation <thermal> & calibration", id: "investigation" }, { label: "Fit #1", id: "fit" }, { label: "Landscape" }];
  assertEquals(breadcrumbText(crumb), "A very long investigation <thermal> & calibration / Fit #1 / Landscape");
  assertEquals(breadcrumbText([]), "");
  const html = mainMarkup({ crumb, meta: "", actions: [], body: { kind: "empty", text: "" }, credit: "" }, 320);
  const nav = html.match(/<nav[^>]*>(.*?)<\/nav>/)![1];
  assertEquals(nav.replace(/<[^>]+>/g, ""), "A very long investigation &lt;thermal&gt; &amp; calibration / Fit #1 / Landscape");
  assertEquals((nav.match(/> \/ <\/span>/g) ?? []).length, 2);
  assertStringIncludes(html, 'title="A very long investigation &lt;thermal&gt; &amp; calibration / Fit #1 / Landscape"');
  assertStringIncludes(html, 'title="Landscape" aria-current="page"');
  const css = autophysStyles(".app");
  assertStringIncludes(css, ".ap-sep { flex:none;white-space:pre;");
  assertStringIncludes(css, "text-overflow:ellipsis");
});
