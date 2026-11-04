import { assertEquals, assertInstanceOf, assertRejects } from "jsr:@std/assert";
import { GoogleAuth } from "./google.ts";

type Config = Parameters<GoogleAuth.Api["accounts"]["oauth2"]["initCodeClient"]>[0];

/** A GIS stand-in: `requestCode` answers through whichever callback the case chooses. */
function gis(answer: (config: Config) => void): { api: GoogleAuth.Api; configs: Config[] } {
  const configs: Config[] = [];
  const api: GoogleAuth.Api = {
    accounts: {
      oauth2: {
        initCodeClient: (config) => {
          configs.push(config);
          return { requestCode: () => answer(config) };
        },
      },
    },
  };
  return { api, configs };
}

function recorder() {
  const events: string[] = [];
  const observer: GoogleAuth.Observer = {
    onHandoff: () => events.push("handoff"),
    onFailure: (failure) => events.push(`failure:${failure}`),
  };
  return { events, observer };
}

Deno.test("google-auth: a code resolves after one handoff and no failure", async () => {
  const { events, observer } = recorder();
  const { api, configs } = gis((c) => c.callback({ code: "auth-code" }));
  assertEquals(await GoogleAuth.requestCode(api, "client", ["a", "b"], { observer }), "auth-code");
  assertEquals(events, ["handoff"]);
  assertEquals(configs[0].scope, "a b");
  assertEquals(configs[0].select_account, true);
});

Deno.test("google-auth: an explicit refusal is access_denied; other OAuth errors are provider_error", async () => {
  for (const [response, failure] of [
    [{ error: "access_denied" }, "access_denied"],
    [{ error: "invalid_scope" }, "provider_error"],
    [{ error: "access_denied", code: "ignored" }, "access_denied"],
    [{}, "provider_error"],
  ] as const) {
    const { events, observer } = recorder();
    const { api } = gis((c) => c.callback(response));
    const error = await assertRejects(() => GoogleAuth.requestCode(api, "client", [], { observer }));
    assertInstanceOf(error, GoogleAuth.LoginError);
    assertEquals(error.failure, failure);
    // The message existing callers already saw; never the provider's.
    assertEquals(error.message, "Google authorization was not granted");
    assertEquals(events, ["handoff", `failure:${failure}`]);
  }
});

Deno.test("google-auth: a blocked popup and a closed popup stay distinct from a refusal", async () => {
  for (const [type, failure] of [
    ["popup_failed_to_open", "popup_failed_to_open"],
    ["popup_closed", "popup_closed"],
    ["unknown", "unknown"],
    ["something_new", "unknown"],
  ] as const) {
    const { events, observer } = recorder();
    const { api } = gis((c) => c.error_callback({ type }));
    const error = await assertRejects(() => GoogleAuth.requestCode(api, "client", [], { observer }));
    assertInstanceOf(error, GoogleAuth.LoginError);
    assertEquals(error.failure, failure);
    assertEquals(error.message, "Google sign-in popup was closed or blocked");
    assertEquals(events, ["handoff", `failure:${failure}`]);
  }
});

Deno.test("google-auth: only the first GIS outcome counts", async () => {
  const { events, observer } = recorder();
  const { api } = gis((c) => {
    c.error_callback({ type: "popup_closed" });
    c.callback({ code: "late-code" });
    c.error_callback({ type: "popup_failed_to_open" });
  });
  const error = await assertRejects(() => GoogleAuth.requestCode(api, "client", [], { observer }));
  assertEquals((error as GoogleAuth.LoginError).failure, "popup_closed");
  assertEquals(events, ["handoff", "failure:popup_closed"]);
});

Deno.test("google-auth: a throwing or rejecting observer never changes the login", async () => {
  const throwing: GoogleAuth.Observer = {
    onHandoff: () => { throw new Error("telemetry down"); },
    onFailure: () => { throw new Error("telemetry down"); },
  };
  const rejecting: GoogleAuth.Observer = {
    onHandoff: (() => Promise.reject(new Error("telemetry down"))) as () => void,
    onFailure: (() => Promise.reject(new Error("telemetry down"))) as () => void,
  };
  for (const observer of [throwing, rejecting]) {
    const ok = gis((c) => c.callback({ code: "auth-code" }));
    assertEquals(await GoogleAuth.requestCode(ok.api, "client", [], { observer }), "auth-code");
    const denied = gis((c) => c.callback({ error: "access_denied" }));
    const error = await assertRejects(() => GoogleAuth.requestCode(denied.api, "client", [], { observer }));
    assertEquals((error as GoogleAuth.LoginError).failure, "access_denied");
  }
});

Deno.test("google-auth: callers without an observer and with a hint behave as before", async () => {
  const { api, configs } = gis((c) => c.callback({ code: "auth-code" }));
  assertEquals(await GoogleAuth.requestCode(api, "client", ["s"], { hint: "linked@example.test" }), "auth-code");
  assertEquals(configs[0].select_account, false);
  assertEquals(configs[0].login_hint, "linked@example.test");
  const thrown = gis(() => { throw new Error("gis internal"); });
  const error = await assertRejects(() => GoogleAuth.requestCode(thrown.api, "client", []));
  // A local exception is the client's, never labelled as Google's.
  assertEquals((error as GoogleAuth.LoginError).failure, "client_error");
  // The rejection keeps the thrown message, as before the classification, and its cause.
  assertEquals((error as GoogleAuth.LoginError).message, "gis internal");
  assertEquals(((error as GoogleAuth.LoginError).cause as Error).message, "gis internal");
});

Deno.test("google-auth: a client setup failure is reported once, and without a handoff", async () => {
  const { events, observer } = recorder();
  const broken: GoogleAuth.Api = {
    accounts: { oauth2: { initCodeClient: () => { throw new TypeError("bad config"); } } },
  };
  const error = await assertRejects(() => GoogleAuth.requestCode(broken, "client", [], { observer }));
  assertEquals((error as GoogleAuth.LoginError).failure, "client_error");
  assertEquals((error as GoogleAuth.LoginError).message, "bad config");
  // initCodeClient threw before the handoff: only the failure is reported.
  assertEquals(events, ["failure:client_error"]);
});

/** Run `body` with `crypto.randomUUID` replaced, restoring it afterwards. */
async function withRandomUUID(replacement: unknown, body: () => Promise<void>) {
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: replacement, configurable: true, writable: true });
  try {
    await body();
  } finally {
    delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
  }
}

Deno.test("google-auth: a press shares one attempt between its hooks", async () => {
  const attempt = GoogleAuth.newAttempt();
  assertEquals(typeof attempt?.id, "string");
  const seen: string[] = [];
  const observer = GoogleAuth.attemptObserver(attempt, {
    onAttempt: (a) => seen.push(`attempt:${a.id === attempt?.id}`),
    onAttemptFailure: (a, failure) => seen.push(`failure:${a.id === attempt?.id}:${failure}`),
  });
  const denied = gis((config) => config.callback({ error: "access_denied" }));
  await assertRejects(() => GoogleAuth.requestCode(denied.api, "client", [], { observer }));
  assertEquals(seen, ["attempt:true", "failure:true:access_denied"]);
});

Deno.test("google-auth: without crypto.randomUUID the login still works and the hooks are skipped", async () => {
  for (const replacement of [undefined, () => { throw new Error("insecure context"); }]) {
    await withRandomUUID(replacement, async () => {
      const attempt = GoogleAuth.newAttempt();
      assertEquals(attempt, null);
      const fired: string[] = [];
      const observer = GoogleAuth.attemptObserver(attempt, {
        onAttempt: () => fired.push("attempt"),
        onAttemptFailure: () => fired.push("failure"),
      });
      assertEquals(observer, undefined);
      const ok = gis((config) => config.callback({ code: "the-code" }));
      assertEquals(await GoogleAuth.requestCode(ok.api, "client", ["openid"], { observer }), "the-code");
      const denied = gis((config) => config.callback({ error: "access_denied" }));
      const error = await assertRejects(() => GoogleAuth.requestCode(denied.api, "client", [], { observer }));
      assertEquals((error as GoogleAuth.LoginError).failure, "access_denied");
      assertEquals(fired, []);
    });
  }
  // Restored afterwards.
  assertEquals(typeof GoogleAuth.newAttempt()?.id, "string");
});
