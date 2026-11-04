import { bundle } from "jsr:@libs/bundle/css";
import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";

const decoder = new TextDecoder("utf-8");

export class CssMinifyPlugin implements esbuild.Plugin {
  name: string = "inline-css-minify";

  setup(build: esbuild.PluginBuild) {
    build.onLoad({ filter: /\.ts$/ }, async (args: esbuild.OnLoadArgs) => {
      let contents = decoder.decode(await Deno.readFile(args.path));

      const cssPattern = /css`([^`]+)`/g;
      let matches;
      while ((matches = cssPattern.exec(contents)) != null) {
        try {
          const originalCSS = matches[1];
          const minifiedCSS = await bundle(originalCSS, {
            minify: true,
          });
          contents = contents.replace(originalCSS, minifiedCSS);
        } catch (e) {
          console.log(`${args.path}: Failed to minify`);
          console.log(e);
        }
      }

      return {
        contents,
        loader: "ts",
      };
    });
  }
}
