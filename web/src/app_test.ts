import { assertEquals } from "@std/assert";
import { Cookbook } from "@tento-cookbook";
import { AutophysApp } from "./app.ts";

Deno.test("the autophys app is the vanilla cookbook skeleton with autophys's id and title", () => {
  const app: Cookbook.App = new AutophysApp();
  assertEquals([app.id, app.title], ["autophys", "Autophys"]);
  assertEquals(app instanceof Cookbook.PlaceholderApp, true);
  assertEquals((app.export() as { app: string }).app, "autophys");
});

Deno.test("the placeholder deck is named after the app", () => {
  const slides = Cookbook.Deck.placeholderDeck(new AutophysApp().title);
  assertEquals(slides[0].title, "Autophys");
  assertEquals(slides.length, 6);
});
