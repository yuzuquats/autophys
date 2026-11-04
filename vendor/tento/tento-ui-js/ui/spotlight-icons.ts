import { Div } from "../component-builtin";
import { Typography } from "./typography";

export namespace SpotlightIcons {
  export const text = (t: string) => {
    const $container = Div.make().assignStyles({
      height: "20px",
      width: "20px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });
    $container.appendChild(Typography.h2(t, "h4"));
    return $container;
  };

  export const theme = (bg: string) => {
    return Div.make().assignStyles({
      background: bg,
      height: "20px",
      width: "20px",
      borderRadius: "4px",
    });
  };
}
