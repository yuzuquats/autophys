import { assertEquals } from "jsr:@std/assert";
import { prepareEditorHtml } from "./html-editor-input.ts";

Deno.test("provider HTML document source newlines do not become leading visible breaks", () => {
  const html = '<html>\r\n<head>\r\n<meta charset="utf-8">\r\n</head>\r\n<body>\r\n<p>Agenda <a href="https://example.com">link</a></p>\r\n</body>\r\n</html>';
  assertEquals(prepareEditorHtml(html), html);
});
Deno.test("plain multiline descriptions retain line breaks and literal angle brackets", () => {
  assertEquals(prepareEditorHtml("2 < 3 & 4\r\nhttps://example.com\nnext"), "2 &lt; 3 &amp; 4<br>https://example.com<br>next");
});
Deno.test("linked descriptions keep their markup without adding breaks", () => {
  const html = '<p>Agenda\n<a href="https://example.com">link</a></p>';
  assertEquals(prepareEditorHtml(html), html);
  assertEquals(prepareEditorHtml(""), "");
  assertEquals(prepareEditorHtml("<p></p>"), "<p></p>");
});

Deno.test("already escaped provider text is not escaped a second time", () => {
  assertEquals(prepareEditorHtml("literal &lt;b&gt; &amp; &amp;lt;tag&amp;gt;\nnext"), "literal &lt;b&gt; &amp; &amp;lt;tag&amp;gt;<br>next");
});
