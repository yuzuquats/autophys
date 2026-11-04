import "./home-grid-card";
import "./text-card";
import "./number-card";

import { Storybook } from "@tento-ui/ui/storybook";
import { Toast } from "@tento-ui/components/toast/toast";
import { Typography } from "@tento-ui/ui/typography";
import { NaiveDate } from "@tento-chrono";
import { HomeGridCard, type HomeGridMode } from "./home-grid-card";
import { SheetRowTextCard } from "./text-card";
import { SheetRowNumberCard } from "./number-card";
import { RowIcon } from "./row-icon";
import { TextIcon, LonaIcons, NumberIcon } from "@tento-ui/ui/icons";

function makeListContent(text: string): HTMLElement {
  const $content = Typography.p(text);
  $content.assignStyles({ color: "var(--text-ter)" });
  return $content;
}

function makeBadge(icon: HTMLTemplateElement): () => HTMLElement {
  return () => RowIcon.make().bind({ icon: null }, { icon });
}

type WrapInGridCardOptions = {
  $cardContent: HTMLElement;
  $listContent?: Option<HTMLElement>;
  $listAccessory?: Option<HTMLElement>;
  title: string;
  icon?: HTMLTemplateElement;
  contentBg?: string;
  mode?: HomeGridMode;
  checked?: boolean;
};

export function $makeHomeCard(options: WrapInGridCardOptions): HTMLElement {
  const today = NaiveDate.today();
  const datePartial = NaiveDate.Partial.fromDate(today);
  const mode = options.mode ?? "cards";

  options.$cardContent.style.position = "relative";

  const $card = HomeGridCard.makeWith(
    {
      id: `card-${Math.random().toString(36).slice(2)}`,
      title: options.title,
      caption: "Today",
      card: {
        $content: options.$cardContent,
        contentBg: options.contentBg ?? "var(--bg)",
        bg: "var(--bg-hover-opaque)",
        backBg: "var(--teal-dimmed)",
      },
      list: {
        $content: options.$listContent ?? null,
        $accessory: options.$listAccessory,
      },
      $badge: makeBadge(options.icon ?? LonaIcons.$template(TextIcon)),
      date: datePartial,
      localDate: today,
      checked: options.checked ?? false,
      onStateChange: (checked) => Toast.info(`Checked: ${checked}`),
      hasShadow: true,
    },
    150,
  );
  $card.toggleMode(mode, false);

  return $card.assignStyles({
    position: "relative",
  });
}

export class HomeGridCardStoryBook extends Storybook.Default {
  title(): string {
    return "Home Grid Card";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Text Card in Context",
        render: () =>
          $makeHomeCard({
            title: "Daily Journal",
            icon: LonaIcons.$template(TextIcon),
            $cardContent: SheetRowTextCard.makeWith({
              value: "Hello **world**!",
              onUpdate: (md) => Toast.info(`Updated: ${md}`),
            }),
            $listContent: makeListContent("Tap to add an entry"),
          }),
      },
      {
        title: "Number Card in Context",
        render: () =>
          $makeHomeCard({
            title: "Daily Steps",
            icon: LonaIcons.$template(NumberIcon),
            contentBg: "var(--bg-hover-opaque)",
            $cardContent: SheetRowNumberCard.makeWith({
              value: 8500,
              onUpdate: (v) => Toast.info(`Updated: ${v}`),
            }),
          }),
      },
      {
        title: "Text Card (List Mode)",
        render: () =>
          $makeHomeCard({
            title: "Daily Journal",
            icon: LonaIcons.$template(TextIcon),
            $cardContent: SheetRowTextCard.makeWith({
              value: "",
              onUpdate: (md) => Toast.info(`Updated: ${md}`),
            }),
            $listContent: makeListContent("Tap to add an entry"),
            mode: "list",
          }),
      },
    ];
  }
}
