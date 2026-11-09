import { assertEquals } from "jsr:@std/assert@1";
import type { Investigation, Project } from "../client/domain.ts";
import { type OpenSession, openAccess, openAddress, openSelection, slug, withoutOpen } from "./open-address.ts";

Deno.test("open addresses accept only the reserved users, registered kinds and slugs", () => {
  assertEquals(openAddress("?open=demo/workbook/battery_cycler_demo"), { user: "demo", kind: "workbook", name: "battery_cycler_demo" });
  assertEquals(openAddress("?open=demo%2Fworkbook%2Fthermal_rc_demo&x=1"), { user: "demo", kind: "workbook", name: "thermal_rc_demo" });
  assertEquals(openAddress("?x=1&open=me/workbook/cell-2.v1")?.user, "me");
  assertEquals(openAddress("?open=local/workbook/a")?.user, "local");
  for (const search of [
    "", "?selection=bench-b", "?open=", "?open=demo/workbook", "?open=demo/workbook/a/b",
    "?open=bob/workbook/a", "?open=u_1/workbook/a", "?open=demo/notebook/a", "?open=demo/workbook/..",
    "?open=demo/workbook/a..b", "?open=demo/workbook/.a", "?open=demo/workbook/Battery",
    "?open=demo/workbook/a%20b", "?open=demo/workbook/" + "x".repeat(101),
  ]) assertEquals(openAddress(search), null, search);
});

const session = (s: Partial<OpenSession>): OpenSession => ({ signedIn: false, demoWorkspace: false, login: true, allowDemo: true, ...s });
Deno.test("a demo link signs in as the demo, or asks before leaving another account", () => {
  const demo = openAddress("?open=demo/workbook/a")!, me = openAddress("?open=me/workbook/a")!, local = openAddress("?open=local/workbook/a")!;
  assertEquals(openAccess(demo, session({})), "sign-in-demo");
  assertEquals(openAccess(demo, session({ allowDemo: false })), "drop");
  assertEquals(openAccess(demo, session({ signedIn: true })), "confirm-switch");
  assertEquals(openAccess(demo, session({ signedIn: true, demoWorkspace: true })), "open");
  assertEquals(openAccess(demo, session({ login: false, signedIn: true })), "drop");
  assertEquals(openAccess(me, session({})), "drop");
  assertEquals(openAccess(me, session({ signedIn: true })), "open");
  assertEquals(openAccess(local, session({ signedIn: true })), "drop");
  assertEquals(openAccess(local, session({ login: false, signedIn: true })), "open");
});

const inv = (id: string, state: Investigation["state"], updatedUtc?: string) => ({ id, state, updatedUtc }) as Investigation;
const project = (id: string, name: string, investigations: Investigation[]) => ({ id, name, configs: [], investigations }) as Project;
Deno.test("a workbook link selects its newest validated investigation, else its config", () => {
  const address = openAddress("?open=demo/workbook/battery_cycler_demo")!;
  const projects = [
    project("prj_other", "thermal_rc_demo", [inv("inv_t", "validated", "2026-11-08 09:00 UTC")]),
    project("prj_bat", "battery_cycler_demo", [
      inv("inv_a", "validated", "2026-11-04 10:07 UTC"), inv("inv_b", "validated", "2026-11-05 08:00 UTC"),
      inv("inv_c", "inconclusive", "2026-11-06 08:00 UTC"), inv("inv_d", "running", "2026-11-07 08:00 UTC"),
    ]),
  ];
  assertEquals(openSelection(projects, address), { projectId: "prj_bat", id: "inv_b" });
  // A tie, or no recorded time, goes to the later record.
  assertEquals(openSelection([project("prj_bat", "battery_cycler_demo", [inv("inv_a", "validated"), inv("inv_b", "validated")])], address)?.id, "inv_b");
  assertEquals(openSelection([project("prj_bat", "battery_cycler_demo", [inv("inv_c", "awaiting-data")])], address), { projectId: "prj_bat", id: "config:prj_bat" });
  // A project named in words is linked by its workbook slug.
  assertEquals(openSelection([project("prj_x", "Battery Cycler Demo!", [])], openAddress("?open=me/workbook/battery-cycler-demo")!)?.id, "config:prj_x");
  assertEquals(openSelection(projects, openAddress("?open=demo/workbook/missing")!), null);
});

Deno.test("slug matches the SDKs' workbook file names; the open parameter leaves the address cleanly", () => {
  for (const [name, expected] of [["battery_cycler_demo", "battery_cycler_demo"], ["Battery Cycler (v2)", "battery-cycler-v2"], ["..", "project"], ["-a.b-", "a.b"]]) {
    assertEquals(slug(name), expected, name);
  }
  assertEquals(withoutOpen("?open=demo/workbook/a"), "");
  assertEquals(withoutOpen("?source=fixtures&open=demo%2Fworkbook%2Fa"), "?source=fixtures");
});
