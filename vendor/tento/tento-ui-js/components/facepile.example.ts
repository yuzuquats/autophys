import { Storybook } from "../ui/storybook";
import { Avatar } from "./avatar";
import { Facepile } from "./facepile";

export class FacepileStoryBook extends Storybook.Default {
  title(): string {
    return "Facepile";
  }

  tags(): string[] {
    return ["std-facepile"];
  }

  examples(): Storybook.Example[] {
    const people: Avatar.Props[] = [
      { initials: "MZ", backgroundColor: "var(--blue)", color: "var(--bg)" },
      { initials: "AH", backgroundColor: "var(--orange)", color: "var(--bg)" },
      { initials: "SN", backgroundColor: "var(--red)", color: "var(--bg)" },
      { initials: "JK", backgroundColor: "var(--text-pri)", color: "var(--bg)" },
      { initials: "LP", backgroundColor: "var(--text-sec)", color: "var(--bg)" },
    ];
    return [
      { title: "Three of three, 32px", render: () => Facepile.makeWith({ avatars: people.slice(0, 3), max: 5, sizePx: 32 }) },
      { title: "Five with max 3 — \"+2\"", render: () => Facepile.makeWith({ avatars: people, max: 3, sizePx: 24 }) },
      {
        title: "Slotted faces (the older composition still works)",
        render: () => {
          const $c = Facepile.make();
          $c.setAttribute("size", "32");
          for (const p of people.slice(0, 2)) $c.appendChild(Avatar.makeWithInitials({ ...p, size: "32" }));
          return $c;
        },
      },
    ];
  }
}
