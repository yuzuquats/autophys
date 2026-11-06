import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { readContext } from "./api.ts";

Deno.test("context: refreshing account capabilities uses an uncached same-origin request", async () => {
  const context = {
    principal: null,
    workspace: null,
    capabilities: { read: false, createProject: false, startInvestigation: false, approveProposal: false, manageDevices: false },
    auth: { canSignIn: true, canSignOut: false, allowDemo: false },
  };
  let url: string | undefined, init: RequestInit | undefined;
  const http: typeof fetch = (input, options) => {
    url = String(input);
    init = options;
    return Promise.resolve(Response.json(context));
  };
  assertEquals(await readContext(http), context);
  assertEquals([url, init?.credentials, init?.cache], [
    "/api/v1/context",
    "same-origin",
    "no-store",
  ]);
});

Deno.test("context: a refused identity read cannot become an authenticated context", async () => {
  const http: typeof fetch = () =>
    Promise.resolve(
      Response.json({ principal: { id: "stale" } }, { status: 401 }),
    );
  await assertRejects(
    () => readContext(http),
    Error,
    "Couldn't resolve your workspace",
  );
});
