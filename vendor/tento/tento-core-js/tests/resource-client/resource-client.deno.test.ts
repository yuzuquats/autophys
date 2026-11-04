import { assertEquals, assertRejects } from "jsr:@std/assert";

import { ResourceClient } from "../../resource-client.ts";

const ORIGIN = {
  hostname: "calendar.lona.so",
  protocol: "https:",
  staticOrigin: null,
};

Deno.test("ResourceClient.url resolves static aliases on production hosts", () => {
  const client = ResourceClient.forOrigin("static", ORIGIN);
  assertEquals(
    client.url("/@/static/css/reset.css"),
    "https://static.lona.so/css/reset.css",
  );
});

Deno.test("ResourceClient.url resolves static resources on fleet-prefixed hosts", () => {
  const client = ResourceClient.forOrigin("static", {
    hostname: "aws-10--calendar.lona.so",
    protocol: "https:",
    staticOrigin: null,
  });
  assertEquals(
    client.url("/img/stickers/registry.json"),
    "https://aws-10--static.lona.so/img/stickers/registry.json",
  );
});

Deno.test("ResourceClient.url resolves static timezone resources on dev hosts", () => {
  const client = ResourceClient.forOrigin("static", {
    hostname: "dev--calendar.lona.so",
    protocol: "https:",
    staticOrigin: null,
  });
  assertEquals(
    client.url("/timezones/2024b/1900_2050/America~Los_Angeles.json"),
    "https://dev--static.lona.so/timezones/2024b/1900_2050/America~Los_Angeles.json",
  );
});

Deno.test("ResourceClient.url preserves an explicit static origin hook", () => {
  const client = ResourceClient.forOrigin("static", {
    hostname: "dev--calendar.lona.so",
    protocol: "https:",
    staticOrigin: "https://dev--static.lona.so:8443",
  });
  assertEquals(
    client.url("/@/static/changelog/current.txt"),
    "https://dev--static.lona.so:8443/changelog/current.txt",
  );
});

Deno.test("ResourceClient.url resolves root-domain content", () => {
  const client = ResourceClient.forOrigin("root", {
    hostname: "dev--calendar.lona.so",
    protocol: "https:",
    staticOrigin: null,
  });
  assertEquals(
    client.url("/docs/content/core/intro.md"),
    "https://dev.lona.so/docs/content/core/intro.md",
  );
});

Deno.test("ResourceClient.url resolves arbitrary service domains", () => {
  const client = ResourceClient.forOrigin("blog", {
    hostname: "aws-04.lona.so",
    protocol: "http:",
    staticOrigin: null,
  });
  assertEquals(
    client.url("/post"),
    "http://aws-04--blog.lona.so/post",
  );
});

Deno.test("ResourceClient.url preserves absolute HTTP URLs", () => {
  const client = ResourceClient.forOrigin("static", ORIGIN);
  assertEquals(
    client.url("https://cdn.example.com/file.txt"),
    "https://cdn.example.com/file.txt",
  );
});

Deno.test("ResourceClient.url preserves current-origin resource paths", () => {
  const client = ResourceClient.currentOriginFor(ORIGIN);
  assertEquals(
    client.url("/@/static/weather/locations.json"),
    "/@/static/weather/locations.json",
  );
});

Deno.test("ResourceClient fetches text, bytes, and parsed JSON", async () => {
  const client = ResourceClient.forOrigin("static", ORIGIN).withFetcher(
    async (url) => {
      if (url.endsWith("/bytes.bin")) {
        return new Response(new Uint8Array([1, 2, 3]).buffer);
      }
      if (url.endsWith("/data.json")) {
        return new Response(JSON.stringify({ value: 42 }));
      }
      return new Response("hello");
    },
  );

  assertEquals(await client.text("/hello.txt"), "hello");
  assertEquals(await client.bytes("/bytes.bin"), new Uint8Array([1, 2, 3]));
  assertEquals(
    await client.json("/data.json", (raw) => {
      if (typeof raw?.value !== "number") {
        throw new Error("expected numeric value");
      }
      return raw.value;
    }),
    42,
  );
});

Deno.test("ResourceClient rejects non-2xx responses with URL context", async () => {
  const client = ResourceClient.forOrigin("static", ORIGIN).withFetcher(
    async () => new Response("missing", { status: 404 }),
  );

  await assertRejects(
    () => client.text("/missing.txt"),
    Error,
    "GET https://static.lona.so/missing.txt failed with status 404",
  );
});
