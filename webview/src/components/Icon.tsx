/**
 * Original minimal 16px stroke icons (no external assets, no third-party
 * icon fonts). Rendered inline so they inherit `currentColor` and theme.
 */
import { memo, type ReactElement } from "react";
import { cn } from "../utils";

export type IconName =
  | "plus"
  | "clock"
  | "gear"
  | "send"
  | "stop"
  | "paperclip"
  | "chevron"
  | "infinity"
  | "dots"
  | "filter"
  | "grid"
  | "panel"
  | "fork"
  | "check"
  | "x"
  | "pencil"
  | "trash"
  | "file"
  | "folder"
  | "spinner"
  | "copy"
  | "refresh"
  | "search"
  | "back"
  | "alert"
  | "terminal"
  | "external"
  | "chat"
  | "at"
  | "bolt";

const PATHS: Record<IconName, ReactElement> = {
  plus: (
    <>
      <path d="M8 3.5v9" />
      <path d="M3.5 8h9" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 2" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.75v1.9M8 12.35v1.9M1.75 8h1.9M12.35 8h1.9M3.55 3.55l1.34 1.34M11.11 11.11l1.34 1.34M12.45 3.55l-1.34 1.34M4.89 11.11l-1.34 1.34" />
    </>
  ),
  send: (
    <>
      <path d="M13.75 2.25 6.9 9.1" />
      <path d="M13.75 2.25 9.4 13.75 6.9 9.1 2.25 6.6Z" />
    </>
  ),
  stop: <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1" />,
  paperclip: (
    <path d="M14.29 7.37 8.16 13.5a4 4 0 0 1-5.66-5.66l6.13-6.13a2.67 2.67 0 0 1 3.77 3.77l-6.13 6.13a1.33 1.33 0 0 1-1.89-1.89l5.66-5.65" />
  ),
  chevron: <path d="m4 6 4 4 4-4" />,
  check: <path d="m3 8.5 3.5 3.5L13 5" />,
  x: (
    <>
      <path d="m4 4 8 8" />
      <path d="m12 4-8 8" />
    </>
  ),
  pencil: (
    <>
      <path d="M11.34 2a1.9 1.9 0 0 1 2.68 2.68L5.35 13.35 2 14l.65-3.35Z" />
      <path d="m10.25 3.1 2.65 2.65" />
    </>
  ),
  trash: (
    <>
      <path d="M2 4h12" />
      <path d="M5.5 4V2.75A.75.75 0 0 1 6.25 2h3.5a.75.75 0 0 1 .75.75V4" />
      <path d="m12.5 4-.6 9a1.5 1.5 0 0 1-1.5 1.4H5.6a1.5 1.5 0 0 1-1.5-1.4L3.5 4" />
      <path d="M6.5 7v4.5M9.5 7v4.5" />
    </>
  ),
  file: (
    <>
      <path d="M4 1.75h4.75l4 3.85v8.65a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1Z" />
      <path d="M8.75 1.75v3.85h4" />
    </>
  ),
  folder: (
    <path d="M1.75 4.1a1 1 0 0 1 1-1h3.1L7.4 5.2h5.85a1 1 0 0 1 1 1v6.7a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1Z" />
  ),
  spinner: (
    <>
      <circle cx="8" cy="8" r="5.75" opacity="0.25" />
      <path d="M8 2.25A5.75 5.75 0 0 1 13.75 8" />
    </>
  ),
  copy: (
    <>
      <rect x="5.75" y="5.75" width="8" height="8" rx="1" />
      <path d="M10.25 3.75v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M13.75 8A5.75 5.75 0 1 1 11.9 3.7" />
      <path d="M12.25 1.5v2.5h-2.5" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.5 10.5 14 14" />
    </>
  ),
  back: (
    <>
      <path d="M13 8H3" />
      <path d="M7 4 3 8l4 4" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.25 14.75 13.5H1.25Z" />
      <path d="M8 6.5v3" />
      <path d="M8 11.6h.01" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1" />
      <path d="m4.25 6.5 2.25 2-2.25 2" />
      <path d="M8 10.5h3.75" />
    </>
  ),
  external: (
    <>
      <path d="M6.5 3.5H3.25a1 1 0 0 0-1 1v8.25a1 1 0 0 0 1 1h8.25a1 1 0 0 0 1-1V9.5" />
      <path d="M9.5 2.5h4v4" />
      <path d="M13.5 2.5 8 8" />
    </>
  ),
  chat: <path d="M2 3.25h12v8.5H8.5L5 14.75v-3H2Z" />,
  at: (
    <>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M10.5 8v.75a1.75 1.75 0 0 0 3.5 0V8a6 6 0 1 0-2.35 4.77" />
    </>
  ),
  bolt: <path d="M8.75 1.75 3.5 9.25h3.75L7.25 14.25 12.5 6.75H8.75Z" />,
  infinity: (
    <>
      <path d="M4.5 5.5c-2.2 0-2.2 5 0 5 2.4 0 4.6-5 7-5 2.2 0 2.2 5 0 5-2.4 0-4.6-5-7-5Z" />
    </>
  ),
  dots: (
    <>
      <circle cx="3" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="13" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  filter: <path d="M2 3.5h12l-4.7 5.2v3.8L6.7 14V8.7L2 3.5Z" />,
  grid: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>
  ),
  panel: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M9.5 3v10" />
    </>
  ),
  fork: (
    <>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M4 5v5.5M4 8h6.5" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export const Icon = memo(function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={cn("icon", className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
});
