import { Storybook } from "../../ui/storybook";
import { Toast } from "../toast/toast";
import { YoutubePlaylist } from "./youtube-playlist";
import { YoutubeUrl } from "./youtube-url";

export class YoutubePlaylistStoryBook extends Storybook.Default {
  title(): string {
    return "YouTube Playlist";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Single Video",
        render: () => YoutubePlaylist.makeWith({
          urls: [
            YoutubeUrl.parse("https://www.youtube.com/watch?v=dQw4w9WgXcQ")!,
          ],
          selectedIndex: 0,
          onChange: (index) => {
            Toast.info(`Selected video ${index + 1}`);
          },
        }).assignStyles({
          border: "1px solid var(--divider)",
          borderRadius: "8px",
        }),
      },
      {
        title: "Three Videos",
        render: () => {
          const urls = [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            "https://www.youtube.com/watch?v=y6120QOlsfU",
          ]
            .map((url) => YoutubeUrl.parse(url))
            .filter((url): url is YoutubeUrl => url !== undefined);

          return YoutubePlaylist.makeWith({
            urls,
            selectedIndex: 0,
            showIndicator: true,
            onChange: (index) => {
              Toast.info(`Selected video ${index + 1} of ${urls.length}`);
            },
          }).assignStyles({
            border: "1px solid var(--divider)",
            borderRadius: "8px",
          });
        },
      },
      {
        title: "Five Videos with Custom Width",
        render: () => {
          const urls = [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            "https://www.youtube.com/watch?v=y6120QOlsfU",
            "https://www.youtube.com/watch?v=9bZkp7q19f0",
            "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
          ]
            .map((url) => YoutubeUrl.parse(url))
            .filter((url): url is YoutubeUrl => url !== undefined);

          return YoutubePlaylist.makeWith({
            urls,
            selectedIndex: 2,
            showIndicator: true,
            onChange: (index) => {
              Toast.info(`Now viewing: Video ${index + 1}`);
            },
          }).assignStyles({
            border: "1px solid var(--divider)",
            borderRadius: "8px",
          });
        },
      },
      {
        title: "Ten Videos (Maximum)",
        render: () => {
          const urls = [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            "https://www.youtube.com/watch?v=y6120QOlsfU",
            "https://www.youtube.com/watch?v=9bZkp7q19f0",
            "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
            "https://www.youtube.com/watch?v=fJ9rUzIMcZQ",
            "https://www.youtube.com/watch?v=QB7ACr7pUuE",
            "https://www.youtube.com/watch?v=2vjPBrBU-TM",
            "https://www.youtube.com/watch?v=oHg5SJYRHA0",
            "https://www.youtube.com/watch?v=ZZ5LpwO-An4",
          ]
            .map((url) => YoutubeUrl.parse(url))
            .filter((url): url is YoutubeUrl => url !== undefined);

          return YoutubePlaylist.makeWith({
            urls,
            selectedIndex: 0,
            showIndicator: true,
            onChange: (index) => {
              Toast.info(`Video ${index + 1} of ${urls.length}`);
            },
          }).assignStyles({
            border: "1px solid var(--divider)",
            borderRadius: "8px",
          });
        },
      },
      {
        title: "Empty State",
        render: () => YoutubePlaylist.makeWith({
          urls: [],
          selectedIndex: 0,
        }).assignStyles({
          border: "1px solid var(--divider)",
          borderRadius: "8px",
        }),
      },
      {
        title: "Mixed Video Formats (including Shorts)",
        render: () => {
          const urls = [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/shorts/5GMWQbkLJHM",
            "https://youtu.be/jNQXAC9IVRw",
            "https://www.youtube.com/shorts/abc123def45",
          ]
            .map((url) => YoutubeUrl.parse(url))
            .filter((url): url is YoutubeUrl => url !== undefined);

          return YoutubePlaylist.makeWith({
            urls,
            selectedIndex: 0,
            showIndicator: true,
            onChange: (index) => {
              Toast.info(`Selected video ${index + 1} of ${urls.length}`);
            },
          }).assignStyles({
            border: "1px solid var(--divider)",
            borderRadius: "8px",
          });
        },
      },
    ];
  }
}
