"use client";
import { useSyncExternalStore } from "react";
import { Icon } from "./Icon";

function subscribe(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}
export function ThemeToggle() {
  const dark = useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.theme === "dark",
    () => false,
  );
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      onClick={() => {
        const theme = dark ? "light" : "dark";
        document.documentElement.dataset.theme = theme;
        try {
          localStorage.setItem("campuspulse-theme", theme);
        } catch {
          /* Theme remains usable when storage is unavailable. */
        }
      }}
    >
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}
