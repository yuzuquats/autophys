import { assertEquals } from "jsr:@std/assert";

const listeners = new Map<string, EventListener>();

Object.defineProperty(globalThis, "window", {
  value: {
    location: new URL("https://dev--calendar.lona.so/"),
    addEventListener: (type: string, listener: EventListener) => {
      listeners.set(type, listener);
    },
    toString: () => "https://dev--calendar.lona.so/",
  },
  configurable: true,
});

Object.defineProperty(globalThis, "document", {
  value: {
    location: new URL("https://dev--calendar.lona.so/"),
  },
  configurable: true,
});

const historyCalls: string[] = [];
Object.defineProperty(globalThis, "history", {
  value: {
    pushState: (state: object, title: string, url: URL | string) => {
      void state;
      void title;
      historyCalls.push(String(url));
    },
  },
  configurable: true,
});

const { Router } = await import("./router.ts");

Deno.test("native route events never append duplicate history entries", () => {
  Router.addRoute("/", () => {});
  for (const type of ["load", "hashchange", "popstate"]) listeners.get(type)!(new Event(type));
  assertEquals(historyCalls, []);
});

Deno.test("Router.navigateTo decodes wildcard route parameters", () => {
  let routed: Option<string[]> = null;

  Router.addRoute("/booking/{username}/{linkname}", (components) => {
    routed = components;
  });

  Router.navigateTo(
    "https://dev--calendar.lona.so/booking/l3thal.cow%40gmail.com/1234",
    false,
  );

  assertEquals(routed, ["l3thal.cow@gmail.com", "1234"]);
  assertEquals(historyCalls, []);
});

Deno.test("Router.navigateTo leaves malformed wildcard escapes intact", () => {
  let routed: Option<string[]> = null;

  Router.addRoute("/malformed/{value}", (components) => {
    routed = components;
  });

  Router.navigateTo(
    "https://dev--calendar.lona.so/malformed/bad%zz",
    false,
  );

  assertEquals(routed, ["bad%zz"]);
});

Deno.test("Router.sectionOf returns the leading path segment", () => {
  assertEquals(Router.sectionOf("/features/calendar"), "features");
  assertEquals(Router.sectionOf("/solutions/health-fitness"), "solutions");
  assertEquals(Router.sectionOf("/pricing"), "pricing");
  assertEquals(Router.sectionOf("/Features/Calendar"), "features"); // lowercased
  assertEquals(Router.sectionOf("/"), "");
  assertEquals(Router.sectionOf(""), "");
});
