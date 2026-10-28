import { useId } from "react";

// Geometry comes from the approved mark-on-light/dark.svg assets.
// The viewBox trims empty margins only; mask black/white are coverage, not theme colors.
export function BrandMark() {
  const prefix = "brand-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg
      className="brand-mark"
      viewBox="20 20 88 88"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <symbol id={prefix + "-x"} viewBox="0 0 128 128">
          <mask
            id={prefix + "-xm"}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="128"
            height="128"
          >
            <rect width="128" height="128" fill="#fff" />
            <rect
              x="-20"
              y="56.8"
              width="170"
              height="19"
              fill="#000"
              transform="rotate(-30 64 64)"
            />
            <rect x="0" y="0" width="62" height="128" fill="#fff" />
          </mask>
          <mask
            id={prefix + "-xk"}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="128"
            height="128"
          >
            <rect width="128" height="128" fill="#fff" />
            <rect x="0" y="0" width="62" height="128" fill="#000" />
          </mask>
          <g
            mask={"url(#" + prefix + "-xm)"}
            stroke="var(--color-logoMain)"
            fill="none"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M30 80V40a10 10 0 0 1 10-10h48a10 10 0 0 1 10 10v48a10 10 0 0 1-10 10H71.5c-5.5 0-6.5-9-11.5-9s-6 9-11.5 9c-3.5 0-4.5-3.5-7-3.5" />
          </g>
          <clipPath id={prefix + "-xc0"}>
            <rect
              x="-20"
              y="58"
              width="170"
              height="6"
              transform="rotate(-30 64 64)"
            />
          </clipPath>
          <g mask={"url(#" + prefix + "-xk)"}>
            <g clipPath={"url(#" + prefix + "-xc0)"}>
              <g
                transform="translate(2.60 -1.50)"
                fill="none"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <g
                  stroke="var(--color-logoCyan)"
                  transform="translate(-1.4 -1)"
                >
                  <path d="M30 80V40a10 10 0 0 1 10-10h48a10 10 0 0 1 10 10v48a10 10 0 0 1-10 10H71.5c-5.5 0-6.5-9-11.5-9s-6 9-11.5 9c-3.5 0-4.5-3.5-7-3.5" />
                </g>
                <g stroke="var(--color-logoPink)" transform="translate(1.4 1)">
                  <path d="M30 80V40a10 10 0 0 1 10-10h48a10 10 0 0 1 10 10v48a10 10 0 0 1-10 10H71.5c-5.5 0-6.5-9-11.5-9s-6 9-11.5 9c-3.5 0-4.5-3.5-7-3.5" />
                </g>
                <g stroke="var(--color-logoMain)">
                  <path d="M30 80V40a10 10 0 0 1 10-10h48a10 10 0 0 1 10 10v48a10 10 0 0 1-10 10H71.5c-5.5 0-6.5-9-11.5-9s-6 9-11.5 9c-3.5 0-4.5-3.5-7-3.5" />
                </g>
              </g>
            </g>
          </g>
          <clipPath id={prefix + "-xc1"}>
            <rect
              x="-20"
              y="65.6"
              width="170"
              height="4.4"
              transform="rotate(-30 64 64)"
            />
          </clipPath>
          <g mask={"url(#" + prefix + "-xk)"}>
            <g clipPath={"url(#" + prefix + "-xc1)"}>
              <g
                transform="translate(-1.91 1.10)"
                fill="none"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <g
                  stroke="var(--color-logoCyan)"
                  transform="translate(-1.4 -1)"
                >
                  <path d="M30 80V40a10 10 0 0 1 10-10h48a10 10 0 0 1 10 10v48a10 10 0 0 1-10 10H71.5c-5.5 0-6.5-9-11.5-9s-6 9-11.5 9c-3.5 0-4.5-3.5-7-3.5" />
                </g>
                <g stroke="var(--color-logoPink)" transform="translate(1.4 1)">
                  <path d="M30 80V40a10 10 0 0 1 10-10h48a10 10 0 0 1 10 10v48a10 10 0 0 1-10 10H71.5c-5.5 0-6.5-9-11.5-9s-6 9-11.5 9c-3.5 0-4.5-3.5-7-3.5" />
                </g>
                <g stroke="var(--color-logoMain)">
                  <path d="M30 80V40a10 10 0 0 1 10-10h48a10 10 0 0 1 10 10v48a10 10 0 0 1-10 10H71.5c-5.5 0-6.5-9-11.5-9s-6 9-11.5 9c-3.5 0-4.5-3.5-7-3.5" />
                </g>
              </g>
            </g>
          </g>
          <clipPath id={prefix + "-xc2"}>
            <rect
              x="-20"
              y="71.6"
              width="170"
              height="3"
              transform="rotate(-30 64 64)"
            />
          </clipPath>
          <g mask={"url(#" + prefix + "-xk)"}>
            <g clipPath={"url(#" + prefix + "-xc2)"}>
              <g
                transform="translate(3.12 -1.80)"
                fill="none"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <g
                  stroke="var(--color-logoCyan)"
                  transform="translate(-1.4 -1)"
                >
                  <path d="M30 80V40a10 10 0 0 1 10-10h48a10 10 0 0 1 10 10v48a10 10 0 0 1-10 10H71.5c-5.5 0-6.5-9-11.5-9s-6 9-11.5 9c-3.5 0-4.5-3.5-7-3.5" />
                </g>
                <g stroke="var(--color-logoPink)" transform="translate(1.4 1)">
                  <path d="M30 80V40a10 10 0 0 1 10-10h48a10 10 0 0 1 10 10v48a10 10 0 0 1-10 10H71.5c-5.5 0-6.5-9-11.5-9s-6 9-11.5 9c-3.5 0-4.5-3.5-7-3.5" />
                </g>
                <g stroke="var(--color-logoMain)">
                  <path d="M30 80V40a10 10 0 0 1 10-10h48a10 10 0 0 1 10 10v48a10 10 0 0 1-10 10H71.5c-5.5 0-6.5-9-11.5-9s-6 9-11.5 9c-3.5 0-4.5-3.5-7-3.5" />
                </g>
              </g>
            </g>
          </g>
          <clipPath id={prefix + "-xpa"}>
            <rect
              x="0"
              y="-60"
              width="140"
              height="122.4"
              transform="rotate(-30 66 64)"
            />
          </clipPath>
          <clipPath id={prefix + "-xpb"}>
            <rect
              x="0"
              y="65.6"
              width="140"
              height="120"
              transform="rotate(-30 66 64)"
            />
          </clipPath>
          <g clipPath={"url(#" + prefix + "-xpa)"}>
            <g
              transform="translate(1.39 -0.80)"
              stroke="var(--color-logoMain)"
              fill="none"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M58 51.5l19 12.5-19 12.5z" />
            </g>
          </g>
          <g clipPath={"url(#" + prefix + "-xpb)"}>
            <g
              transform="translate(-1.39 0.80)"
              stroke="var(--color-logoMain)"
              fill="none"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M58 51.5l19 12.5-19 12.5z" />
            </g>
          </g>
          <circle cx="32" cy="90.2" r="4.75" fill="var(--color-logoPink)" />
        </symbol>
      </defs>
      <use href={"#" + prefix + "-x"} width="128" height="128" />
    </svg>
  );
}
