import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { mainMarkup } from "./main.ts";
import { detailsMarkup } from "./details.ts";
import { breadcrumbText } from "./breadcrumb.ts";
import type { MainModel } from "./view-model.ts";
import { autophysStyles } from "./styles.ts";

Deno.test("shell: reconnect notice appears once above retained content with one live region", () => {
  for (const body of [{ kind: "unavailable", title: "Workspace", description: "No records loaded" }, { kind: "empty", text: "Last loaded records" }] satisfies MainModel["body"][]) {
    const main = mainMarkup({ crumb: [], meta: "", actions: [], credit: "", body, connectionError: "Lost connection <offline>" }, 640);
    const html = main + detailsMarkup({ icon: "workspace", title: "Workspace", status: { text: "Last loaded records" }, sections: [] });
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
