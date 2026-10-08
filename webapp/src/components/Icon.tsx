import type { SVGProps } from "react";

const paths = {
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  cases: "M9 5V3h6v2 M3 5h18v15H3z M3 10h18 M10 10v3h4v-3",
  book: "M12 5v16 M12 5C8 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-2-1-6-2-10 1Z",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  shield: "M12 3 3 7v6c0 5 9 9 9 9s9-4 9-9V7z M8 12l3 3 5-6",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4",
  sun: "M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 1.5 1.5 M5 19l1.5-1.5 M17.5 6.5 1.5-1.5 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10Z",
  plus: "M12 5v14 M5 12h14",
  arrow: "M5 12h14 M14 7l5 5-5 5",
  chevron: "m9 5 7 7-7 7",
  down: "m6 9 6 6 6-6",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  close: "m6 6 12 12 M6 18 18 6",
  panel: "M3 3h18v18H3z M9 3v18",
  clock: "M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  alert: "M12 3 2 21h20L12 3Z M12 9v5 M12 17v.1",
  check: "m5 12 4 4L19 6",
  refresh: "M20 7V3 M20 7h-4 M20 7a9 9 0 1 0 1 8",
  calendar: "M3 5h18v16H3z M7 3v4 M17 3v4 M3 10h18",
  dots: "M5 12h.01 M12 12h.01 M19 12h.01",
  inbox: "M4 3h16l2 13v5H2v-5L4 3Z M2 16h6l2 3h4l2-3h6",
  sort: "M8 3v18 M4 7l4-4 4 4 M16 21V3 M12 17l4 4 4-4",
  home: "m3 10 9-7 9 7v11h-7v-7h-4v7H3z",
} as const;
export type IconName = keyof typeof paths;
export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
