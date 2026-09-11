import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Tech Blog まとめ",
  version: "0.1.0",
  icons: { 16: "icons/16.png", 48: "icons/48.png", 128: "icons/128.png" },
  action: { default_title: "Tech Blog まとめを開く" }, // default_popup は付けない（付けると onClicked が発火しない）
  background: { service_worker: "src/background/index.ts", type: "module" },
  options_ui: { page: "src/options/index.html", open_in_tab: true },
  permissions: ["alarms", "notifications", "storage", "offscreen", "unlimitedStorage", "tabs"],
  host_permissions: ["https://*/*"],
});
