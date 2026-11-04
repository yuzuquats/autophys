import { assertEquals } from "@std/assert";
import { conferenceOrigin } from "./conference-origin.ts";

const video = (uri: string) => ({ entryPoints: [{ entryPointType: "video", uri }] });

Deno.test("conference origin prefers meeting metadata over the calendar provider", () => {
  assertEquals(conferenceOrigin({ conferenceSolution: { name: " Zoom " } }, "Google Meet"), "Zoom");
  assertEquals(conferenceOrigin(null, "Google Meet"), "Google Meet");
  assertEquals(conferenceOrigin({}, "Google Meet"), null);
});

Deno.test("conference origin identifies provider hosts without matching lookalikes", () => {
  for (const [uri, expected] of [
    ["https://meet.google.com/abc-defg-hij", "Google Meet"],
    ["https://company.zoom.us/j/123", "Zoom"],
    ["https://zoom.com/j/123", "Zoom"],
    ["https://teams.microsoft.com/l/meetup-join/example", "Microsoft Teams"],
    ["https://company.webex.com/meet/example", "Webex"],
    ["https://zoom.us.example.org/j/123", "zoom.us.example.org"],
  ]) assertEquals(conferenceOrigin(video(uri), "Google Meet"), expected);
});

Deno.test("conference origin ignores malformed and telephone entries", () => {
  for (const data of ["Zoom", [], { entryPoints: [null] }, video("javascript:alert(1)"), video("broken")]) {
    assertEquals(conferenceOrigin(data, "Google Meet"), null);
  }
  assertEquals(conferenceOrigin({ entryPoints: [
    { entryPointType: "phone", uri: "tel:+123456789" },
    { entryPointType: "video", uri: "https://company.zoom.us/j/123" },
  ] }, null), "Zoom");
});
