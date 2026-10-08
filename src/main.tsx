import React from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FloatingUsageCapsule } from "./ui/FloatingUsageCapsule";
import { UsageTooltipWindow } from "./ui/UsageTooltip";
import "./style.css";

const windowLabel = isTauri() ? getCurrentWindow().label : "capsule";
const root = document.getElementById("root");

if (!root) {
  throw new Error("CapsuleMeterX root element was not found");
}

createRoot(root).render(
  <React.StrictMode>
    {windowLabel === "tooltip" ? <UsageTooltipWindow /> : <FloatingUsageCapsule />}
  </React.StrictMode>,
);
