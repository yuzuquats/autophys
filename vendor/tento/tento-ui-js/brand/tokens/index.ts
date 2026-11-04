import { chrome as _chrome } from "./chrome";
import { none as colorNone } from "./color/none";
import { warm } from "./color/warm";
import { cool } from "./color/cool";
import { dark } from "./color/dark";
import { bear as colorBear } from "./color/bear";
import { list as colorList } from "./color/list";
import { loaf as colorLoaf } from "./color/loaf";
import { cream } from "./color/cream";
import { none as typoNone, noneFonts as typoNoneFonts } from "./typography/none";
import { serif, serifFonts } from "./typography/serif";
import { sans, sansFonts } from "./typography/sans";
import { list as typoList, listFonts as typoListFonts } from "./typography/list";
import { loaf as typoLoaf, loafFonts as typoLoafFonts } from "./typography/loaf";
import { bear as typoBear, bearFonts as typoBearFonts } from "./typography/bear";
import { editorial } from "./content-typography/editorial";
import { bear as contentBear } from "./content-typography/bear";
import { none as spacingNone } from "./spacing/none";
import { minimal as spacingMinimal } from "./spacing/minimal";
import { comfortable } from "./spacing/comfortable";
import { compact } from "./spacing/compact";
import { list as spacingList } from "./spacing/list";
import { loaf as spacingLoaf } from "./spacing/loaf";
import { bear as spacingBear } from "./spacing/bear";
import { ui as _ui } from "./blog/ui";
import { uiList as _uiList } from "./blog/ui-list";
import { uiLoaf as _uiLoaf } from "./blog/ui-loaf";
import { uiBear as _uiBear } from "./blog/ui-bear";

export const BrandTokens = {
  chrome: _chrome,

  Color: {
    none: colorNone,
    warm,
    cool,
    dark,
    bear: colorBear,
    list: colorList,
    loaf: colorLoaf,
    cream,
  },
  Typography: {
    none: typoNone, noneFonts: typoNoneFonts,
    serif, serifFonts,
    sans, sansFonts,
    list: typoList, listFonts: typoListFonts,
    loaf: typoLoaf, loafFonts: typoLoafFonts,
    bear: typoBear, bearFonts: typoBearFonts,
  },
  ContentTypography: { editorial, bear: contentBear },
  Spacing: {
    none: spacingNone,
    minimal: spacingMinimal,
    comfortable,
    compact,
    list: spacingList,
    loaf: spacingLoaf,
    bear: spacingBear,
  },

  Blog: {
    ui: _ui,
    uiList: _uiList,
    uiLoaf: _uiLoaf,
    uiBear: _uiBear,
  },
} as const;
