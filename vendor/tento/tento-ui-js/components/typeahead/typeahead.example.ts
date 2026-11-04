import { Storybook } from "../../ui/storybook";
import { Typeahead } from "./typeahead";

const CITIES = ["Amsterdam", "Berlin", "Boston", "Buenos Aires", "Cairo", "Chicago", "Delhi", "Dublin", "Lisbon", "London", "Madrid", "Melbourne", "Mumbai", "Nairobi", "Oslo", "Paris", "Seoul", "Sydney", "Tokyo", "Toronto"];

/** Suggestions arrive after a random delay, so a fast typist sends several
 * queries in flight at once — the generation guard is what keeps the list
 * honest. */
function suggest(q: string): Promise<Typeahead.Item[]> {
  const hits = CITIES.filter((c) => c.toLowerCase().startsWith(q.trim().toLowerCase())).slice(0, 6);
  return new Promise((r) => setTimeout(() => r(hits.map((c) => ({ id: c, label: c, $row: null }))), 80 + Math.random() * 400));
}

function $field(allowFreeText: boolean): Typeahead {
  let value = "";
  const $t = Typeahead.make();
  const rebind = () => $t.bind({ value, placeholder: "Type a city", suggest, onSelect: (id) => { value = id; rebind(); }, onInput: (q) => { value = q; }, debounceMs: 150, allowFreeText, label: allowFreeText ? "City (free text allowed)" : "City" });
  rebind();
  $t.style.maxWidth = "320px";
  return $t;
}

export class TypeaheadStoryBook extends Storybook.Default {
  title(): string {
    return "Typeahead";
  }

  tags(): string[] {
    return ["std-typeahead"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Suggestions after a debounce; arrows, Enter, Escape", render: () => $field(false) },
      { title: "Free text allowed", render: () => $field(true) },
    ];
  }
}
