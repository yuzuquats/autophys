import { Storybook } from "../../ui/storybook";
import { LibraryFilterSortRow } from "./library-filter-sort-row";

export class LibraryFilterSortRowStoryBook extends Storybook.Default {
  title(): string { return "Library filter / sort row"; }

  // Added here, not on rwc-03: this host's charter places a card by the tags
  // its storybook declares, and an example that declares none is a card nobody
  // can find.
  tags(): string[] { return ["std-library-filter-sort-row"]; }

  examples(): Storybook.Example[] {
    const $example = (narrow: boolean): LibraryFilterSortRow => {
      const $row = LibraryFilterSortRow.make();
      if (narrow) $row.assignStyles({ width: "320px", maxWidth: "100%" });
      else Storybook.fill($row);
      let filter = "all";
      let sort = "updated";
      const bind = (): void => {
        $row.bind({resultText:filter === "all" ? "Found 12 notes" : "Found 4 notes",controls:[
          {id:"filter",label:"Filter",value:filter,options:[{value:"all",label:"All notes"},{value:"work",label:"Work"}],onChange:value=>{filter=value;bind();}},
          {id:"sort",label:"Sort",value:sort,options:[{value:"updated",label:"Recently edited"},{value:"title",label:"Title A–Z"}],onChange:value=>{sort=value;bind();}},
        ]});
      };
      bind();
      return $row;
    };
    return [
      {title:"Notes · working filter and sort menus",render:()=>$example(false)},
      {title:"Narrow row · count and controls wrap",render:()=>$example(true)},
      {title:"Vault mini-banner vocabulary",render:()=>Storybook.fill(LibraryFilterSortRow.make().bind({resultText:"Found 4253 pins",controls:[
        {id:"group",label:"Group by",value:"artist",options:[{value:"artist",label:"Artist"}],onChange:null},
        {id:"sort",label:"Sort",value:"random",options:[{value:"random",label:"Random (48322)"}],onChange:null},
      ]}))},
    ];
  }
}
