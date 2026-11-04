import { NaiveDate } from "@tento-chrono";

/**
 * What a home card shows for one row: its card content and its list content
 * and accessory. The type parameters let a factory bind its own faces
 * without a cast.
 */
export type RowContent<
  CardContent extends HTMLElement = HTMLElement,
  ListContent extends Option<HTMLElement> = Option<HTMLElement>,
  ListAccessory extends Option<HTMLElement> = Option<HTMLElement>,
> = {
  $cardContent: CardContent;
  $listContent: ListContent;
  $listAccessory: ListAccessory;
};

/**
 * View model for a home card. Contains all display properties without callbacks.
 * Uses nested structure for card/list display variants.
 */
export type HomeCardProps = {
  id: string;
  title: string;
  caption: string;
  card: {
    $content: HTMLElement;
    contentBg: string;
    bg: string;
    backBg: string;
  };
  list: {
    $content: Option<HTMLElement>;
    $accessory?: Option<HTMLElement>;
  };
  $badge: Option<() => HTMLElement>;
  date?: Option<NaiveDate.Partial>;
  localDate?: Option<NaiveDate>;
  checked: boolean;
  hasShadow?: boolean;
  // When set, the avatar renders this element (e.g. a placeholder image) and the
  // card is NON-checkable: no checkmark, no toggle, no onStateChange.
  avatar?: Option<() => HTMLElement>;
  // When true, CARD mode hides the header (avatar/title/caption) so the card's
  // content fills the card (e.g. a self-contained hero card). LIST mode is
  // unaffected (still shows the title).
  hideCardHeader?: boolean;
  // LIST mode normally derives its caption from the card's date
  // (HomeListCell.getDateLabel). When set, this string is used instead — e.g. a
  // placeholder card showing "Your deck's clear" rather than a date.
  listCaption?: Option<string>;
  // Marks a synthetic placeholder card (e.g. the empty/null state). The grid
  // hides its navbar/chrome when the only card is a placeholder.
  isPlaceholder?: boolean;
};

/**
 * Delegate callbacks for home card interactions.
 */
export type HomeCardDelegate = {
  onStateChange?: (isChecked: boolean) => void;
};
