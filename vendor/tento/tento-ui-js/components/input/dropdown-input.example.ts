import { Dropdown } from "../controls/dropdown";
import { DropdownInput } from "./dropdown-input";

export class DropdownInputStoryBook {
  static make(): HTMLElement {
    const $container = document.createElement("div");
    $container.style.padding = "20px";
    $container.style.maxWidth = "400px";

    // Example 1: With timezone-style dropdown
    const $dropdown1 = Dropdown.Legacy.make();
    const $example1 = DropdownInput.makeWith({
      label: "Timezone",
      currentValue: "America/Los_Angeles",
      dropdown: $dropdown1,
    });

    $dropdown1.bind({
      rows: [
        { content: "America/Los_Angeles", data: "America/Los_Angeles" },
        { content: "America/New_York", data: "America/New_York" },
        { content: "Europe/London", data: "Europe/London" },
      ],
      onSelectedRow: (selected) => {
        // Dropdown.RowContent is `string | HTMLElement`; these rows are all
        // strings, and the display text is what the input shows (note row
        // `data` differs from `content` below).
        if (typeof selected.content !== "string") return;
        $example1.updateCurrentValue(selected.content);
      },
    });

    // Example 2: With location-style dropdown
    const $dropdown2 = Dropdown.Legacy.make();
    const $example2 = DropdownInput.makeWith({
      label: "Location",
      currentValue: "Redwood City",
      dropdown: $dropdown2,
    });

    $dropdown2.bind({
      rows: [
        { content: "Redwood City", data: "redwood" },
        { content: "Palo Alto", data: "palo_alto" },
        { content: "Santa Clara", data: "santa_clara" },
      ],
      onSelectedRow: (selected) => {
        // Dropdown.RowContent is `string | HTMLElement`; these rows are all
        // strings, and the display text is what the input shows (note row
        // `data` differs from `content` below).
        if (typeof selected.content !== "string") return;
        $example2.updateCurrentValue(selected.content);
      },
    });

    $container.appendChild($example1);
    $container.appendChild(document.createElement("br"));
    $container.appendChild($example2);

    return $container;
  }
}
