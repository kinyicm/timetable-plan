import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "课表规划",
    short_name: "课表规划",
    description: "拍照导入课表，用一句话把学习安排进日程，到点提醒。",
    start_url: "/",
    display: "standalone",
    background_color: "#101622",
    theme_color: "#101622",
    orientation: "portrait-primary",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
