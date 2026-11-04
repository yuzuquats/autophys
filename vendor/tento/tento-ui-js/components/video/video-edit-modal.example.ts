import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { Overlay } from "../overlay";
import { Toast } from "../toast/toast";
import { VideoEditModal } from "./video-edit-modal";

export class VideoEditModalStoryBook extends Storybook.Default {
  title(): string {
    return "Video Edit Modal";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Empty Modal",
        render: () => {
          return VideoEditModal.makeWith({
            date: "January 15, 2025",
            urls: [],
            onSave: (urls) => {
              Toast.info(`Saved ${urls.length} URLs`);
            },
          });
        },
      },
      {
        title: "Modal with Single URL",
        render: () => {
          return VideoEditModal.makeWith({
            date: "January 15, 2025",
            urls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
            onSave: (urls) => {
              Toast.info(`Saved ${urls.length} URLs`);
            },
          });
        },
      },
      {
        title: "Modal with Multiple URLs",
        render: () => {
          return VideoEditModal.makeWith({
            date: "January 15, 2025",
            urls: [
              "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
              "https://www.youtube.com/watch?v=jNQXAC9IVRw",
              "https://www.youtube.com/watch?v=y6120QOlsfU",
            ],
            onSave: (urls) => {
              Toast.info(`Saved ${urls.length} URLs: ${urls.join(", ")}`);
            },
          });
        },
      },
      {
        title: "Show Modal with Overlay",
        render: () => {
          return Button.makeWithLight("Edit Videos", {
            type: "primary",
            onClick: () => {
              const $modal = VideoEditModal.makeWith({
                date: "January 15, 2025",
                urls: [
                  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                  "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                ],
                onSave: (urls) => {
                  Toast.info(`Saved ${urls.length} URLs`);
                },
              });
              Overlay.reveal($modal);
            },
          });
        },
      },
      {
        title: "Modal at Max URLs (10)",
        render: () => {
          return VideoEditModal.makeWith({
            date: "January 15, 2025",
            urls: [
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
            ],
            onSave: (urls) => {
              Toast.info(`Saved ${urls.length} URLs`);
            },
          });
        },
      },
      {
        title: "Modal with Custom Max (3 URLs, 5 provided)",
        render: () => {
          return VideoEditModal.makeWith({
            date: "January 15, 2025",
            urls: [
              "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
              "https://www.youtube.com/watch?v=jNQXAC9IVRw",
              "https://www.youtube.com/watch?v=y6120QOlsfU",
              "https://www.youtube.com/watch?v=9bZkp7q19f0",
              "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
            ],
            maxUrls: 3,
            onSave: (urls) => {
              Toast.info(`Saved ${urls.length} URLs`);
            },
          });
        },
      },
    ];
  }
}
