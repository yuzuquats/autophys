import { Storybook } from "../../ui/storybook";
import { YoutubePlayer } from "./youtube-player";

export class YoutubePlayerStoryBook extends Storybook.Default {
  title(): string {
    return "YouTube Player";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "YouTube Video Player",
        render: () => {
          return YoutubePlayer.make().bind(
            "https://www.youtube.com/watch?v=jfKfPfyJRdk",
            800,
          );
        },
      },
      {
        title: "YouTube Player - Different Width",
        render: () => {
          return YoutubePlayer.make().bind(
            "https://www.youtube.com/watch?v=jfKfPfyJRdk",
            600,
          );
        },
      },
      {
        title: "YouTube Player - Empty State",
        render: () => {
          return YoutubePlayer.make().bind(null, 800);
        },
      },
      {
        title: "YouTube Shorts URL",
        render: () => {
          return YoutubePlayer.make().bind(
            "https://www.youtube.com/shorts/5GMWQbkLJHM",
            800,
          );
        },
      },
    ];
  }
}
