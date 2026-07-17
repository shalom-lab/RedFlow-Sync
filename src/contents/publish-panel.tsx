import { createRoot } from "react-dom/client";
import { PanelApp } from "./PanelApp";
import "./panel.css";

const HOST_ID = "redflow-sync-root";

function mount() {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  // 挂到 body，避免被页面布局挤出；样式用 fixed 脱离文档流
  (document.body ?? document.documentElement).appendChild(host);

  createRoot(host).render(<PanelApp />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
