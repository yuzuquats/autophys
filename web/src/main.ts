// autophys client: header, pitch deck, app panels (sidebar, main, details)
// and the first-visit tutorial, composed by the drawer.
import { createHeader } from "./header.ts";
import { createDeck } from "./deck.ts";
import { slides } from "./deck-data.ts";
import { createPanels } from "./panels.ts";
import { createTutorial, tourSteps } from "./tutorial.ts";
import { installDrawer } from "./drawer.ts";
import { readHealth } from "./health.ts";

const header = createHeader(() => {
  if (location.pathname !== "/") {
    history.pushState({ autophys: "landing" }, "", "/");
    dispatchEvent(new PopStateEvent("popstate"));
  }
});
const deck = createDeck(slides);
const panels = createPanels();
const tutorial = createTutorial(tourSteps);
installDrawer({ header, deck, panels, tutorial });
void readHealth().then((line) => panels.setHealth(line));
