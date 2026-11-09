import type { ReactNode, SVGProps } from "react";
import type { EngravedIcon } from "react-engraved-background";

function icon(paths: ReactNode): EngravedIcon {
  return function BackgroundIcon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="-4 -4 33 33" {...props}>
        {paths}
      </svg>
    );
  };
}

export const backgroundIcons: readonly EngravedIcon[] = [
  icon(<path d="m7 5-6 7 6 7m10-14 6 7-6 7M14 2l-4 20" />),
  icon(
    <path d="m12 1 10 6v12l-10 6-10-6V7Zm0 12L2 7m10 6L22 7M12 13v12M7 4l10 6" />,
  ),
  icon(<path d="M8 3h8l-1 8 4 5H5l4-5Zm4 13v6" />),
  icon(
    <>
      <circle cx="12" cy="12" r="11" />
      <ellipse cx="12" cy="12" rx="5" ry="11" />
      <path d="M1 12h22M3 6h18M3 18h18" />
    </>,
  ),
  icon(<path d="M5 2h14v21l-7-5-7 5Z" />),
  icon(
    <>
      <rect x="2" y="3" width="22" height="18" rx="3" />
      <circle cx="8" cy="9" r="2" />
      <path d="m3 19 6-6 4 4 5-7 6 8" />
    </>,
  ),
  icon(<path d="m8 16 8-8a3 3 0 0 0-4-4L3 13a5 5 0 0 0 7 7L21 9m-11 5 6-6" />),
  icon(<path d="M5 2h9l5 5v15H5Zm9 0v6h5M8 13h8m-8 4h6" />),
  icon(
    <>
      <path d="M9 18V4l12-2v14M9 8l12-2" />
      <ellipse cx="5" cy="19" rx="4" ry="3" />
      <ellipse cx="17" cy="17" rx="4" ry="3" />
    </>,
  ),
  icon(<path d="M2 7V4h8l3 3h10v15H2Zm0 4h21" />),
  icon(
    <path d="m10 14 4-4m-6 7-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 0 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" />,
  ),
];
