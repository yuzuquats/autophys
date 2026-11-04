import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";

const decoder = new TextDecoder("utf-8");

export class SvgLoaderPlugin implements esbuild.Plugin {
  name: string = "svg-loader";

  setup(build: esbuild.PluginBuild) {
    build.onLoad({ filter: /\.svg$/ }, async (args: esbuild.OnLoadArgs) => {
      const contents = decoder.decode(await Deno.readFile(args.path));
      return {
        contents,
        loader: "text",
      };
    });
  }
}
