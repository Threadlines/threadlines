import React, { type SVGProps, useId } from "react";
import { cn } from "~/lib/utils";

// A file of its own, fetched when the icon first shows: written into this
// module it cost every window about 9 KB at startup.
import antigravityIconUrl from "../assets/antigravity-icon.png";

export type Icon = React.FC<SVGProps<SVGSVGElement>>;

export const GitHubIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 1024 1024" fill="none">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"
      transform="scale(64)"
      fill="currentColor"
    />
  </svg>
);

export const GitIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 256 256">
    <path
      d="M251.17 116.6 139.4 4.82a16.49 16.49 0 0 0-23.31 0l-23.21 23.2 29.44 29.45a19.57 19.57 0 0 1 24.8 24.96l28.37 28.38a19.61 19.61 0 1 1-11.75 11.06L137.28 95.4v69.64a19.62 19.62 0 1 1-16.13-.57V94.2a19.61 19.61 0 0 1-10.65-25.73L81.46 39.44 4.83 116.08a16.49 16.49 0 0 0 0 23.32L116.6 251.17a16.49 16.49 0 0 0 23.32 0l111.25-111.25a16.5 16.5 0 0 0 0-23.33"
      fill="#DE4C36"
    />
  </svg>
);

/** Bare Threadlines brand glyph — matches the marketing nav lockup
 *  (docs/brand/svg/threadlines-glyph.svg). Structure follows currentColor;
 *  the live branch and node carry the accent. */
export const ThreadlinesGlyph: Icon = (props) => {
  const gradientId = `${useId().replaceAll(":", "")}-threadlines-live`;

  return (
    <svg {...props} viewBox="36 86 184 100" fill="none">
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="108"
          y1="98"
          x2="194"
          y2="162"
        >
          <stop offset="0" stopColor="currentColor" stopOpacity="0.45" />
          <stop offset="1" stopColor="var(--primary-graph)" />
        </linearGradient>
      </defs>
      <g strokeLinecap="round" strokeWidth="10">
        <path d="M 44 98 L 212 98" stroke="currentColor" strokeOpacity="0.35" />
        <path d="M 108 98 C 134 98 134 162 160 162 L 188 162" stroke={`url(#${gradientId})`} />
      </g>
      <g fill="currentColor" fillOpacity="0.5">
        <circle cx="70" cy="98" r="7" />
        <circle cx="108" cy="98" r="8.5" />
        <circle cx="178" cy="98" r="7" />
      </g>
      <circle cx="194" cy="162" r="21" fill="var(--primary-graph)" opacity="0.16" />
      <circle cx="194" cy="162" r="12.5" fill="var(--primary-graph)" />
    </svg>
  );
};

/**
 * Device rotation: an upright screen with arrows turning around it.
 *
 * Drawn rather than taken from the icon set, which offers a square with a
 * refresh arrow (reads as "reload") and a pair of devices (reads as
 * "responsive"). Neither says "turn this on its side".
 */
export const RotateDeviceIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* The device, upright, so the arrows read as turning it. */}
    <rect x="9" y="4" width="6" height="16" rx="1.6" />
    {/* Turning down the left... */}
    <path d="M6.2 8.6a7.4 7.4 0 0 0 0 6.8" />
    <path d="m4.3 9.9 1.9-1.5 1.5 1.9" />
    {/* ...and back up the right. */}
    <path d="M17.8 15.4a7.4 7.4 0 0 0 0-6.8" />
    <path d="m19.7 14.1-1.9 1.5-1.5-1.9" />
  </svg>
);

export const SourceControlIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    className={cn("overflow-visible", className)}
    viewBox="0 0 12 12"
    fill="currentColor"
  >
    <path d="M9 2C7.897 2 7 2.897 7 4C7 4.739 7.403 5.385 8 5.731V6.5C8 6.776 7.775 7 7.5 7H4.5C4.325 7 4.156 7.031 4 7.086V3.731C4.597 3.385 5 2.739 5 2C5 0.897 4.103 0 3 0C1.897 0 1 0.897 1 2C1 3.103 1.897 4 3 4V8C1.897 8 1 8.897 1 10C1 11.103 1.897 12 3 12C4.103 12 5 11.103 5 10C5 9.28 4.617 8.647 4.044 8.295C4.122 8.121 4.297 8 4.5 8H7.5C8.327 8 9 7.327 9 6.5V6C10.103 6 11 5.103 11 4C11 2.897 10.103 2 9 2ZM2 2C2 1.449 2.448 1 3 1C3.552 1 4 1.449 4 2C4 2.551 3.552 3 3 3C2.448 3 2 2.551 2 2ZM3 11C2.448 11 2 10.551 2 10C2 9.449 2.448 9 3 9C3.552 9 4 9.449 4 10C4 10.551 3.552 11 3 11ZM9 5C8.448 5 8 4.551 8 4C8 3.449 8.448 3 9 3C9.552 3 10 3.449 10 4C10 4.551 9.552 5 9 5Z" />
  </svg>
);

export const GitLabIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 32 32" fill="none">
    <path
      d="m31.46 12.78-.04-.12-4.35-11.35A1.14 1.14 0 0 0 25.94.6c-.24 0-.47.1-.66.24-.19.15-.33.36-.39.6l-2.94 9h-11.9l-2.94-9A1.14 1.14 0 0 0 6.07.58a1.15 1.15 0 0 0-1.14.72L.58 12.68l-.05.11a8.1 8.1 0 0 0 2.68 9.34l.02.01.04.03 6.63 4.97 3.28 2.48 2 1.52a1.35 1.35 0 0 0 1.62 0l2-1.52 3.28-2.48 6.67-5h.02a8.09 8.09 0 0 0 2.7-9.36Z"
      fill="#E24329"
    />
    <path
      d="m31.46 12.78-.04-.12a14.75 14.75 0 0 0-5.86 2.64l-9.55 7.24 6.09 4.6 6.67-5h.02a8.09 8.09 0 0 0 2.67-9.36Z"
      fill="#FC6D26"
    />
    <path
      d="m9.9 27.14 3.28 2.48 2 1.52a1.35 1.35 0 0 0 1.62 0l2-1.52 3.28-2.48-6.1-4.6-6.07 4.6Z"
      fill="#FCA326"
    />
    <path
      d="M6.44 15.3a14.71 14.71 0 0 0-5.86-2.63l-.05.12a8.1 8.1 0 0 0 2.68 9.34l.02.01.04.03 6.63 4.97 6.1-4.6-9.56-7.24Z"
      fill="#FC6D26"
    />
  </svg>
);

export const AzureDevOpsIcon: Icon = (props) => {
  const id = useId().replaceAll(":", "");
  const gradientA = `${id}-azure-a`;
  const gradientB = `${id}-azure-b`;
  const gradientC = `${id}-azure-c`;

  return (
    <svg {...props} viewBox="0 0 96 96">
      <defs>
        <linearGradient
          id={gradientA}
          x1="-1032.17"
          x2="-1059.21"
          y1="145.31"
          y2="65.43"
          gradientTransform="matrix(1 0 0 -1 1075 158)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#114a8b" />
          <stop offset="1" stopColor="#0669bc" />
        </linearGradient>
        <linearGradient
          id={gradientB}
          x1="-1023.73"
          x2="-1029.98"
          y1="108.08"
          y2="105.97"
          gradientTransform="matrix(1 0 0 -1 1075 158)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopOpacity=".3" />
          <stop offset=".07" stopOpacity=".2" />
          <stop offset=".32" stopOpacity=".1" />
          <stop offset=".62" stopOpacity=".05" />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id={gradientC}
          x1="-1027.16"
          x2="-997.48"
          y1="147.64"
          y2="68.56"
          gradientTransform="matrix(1 0 0 -1 1075 158)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#3ccbf4" />
          <stop offset="1" stopColor="#2892df" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientA})`}
        d="M33.34 6.54h26.04l-27.03 80.1a4.15 4.15 0 0 1-3.94 2.81H8.15a4.14 4.14 0 0 1-3.93-5.47L29.4 9.38a4.15 4.15 0 0 1 3.94-2.83z"
      />
      <path
        fill="#0078d4"
        d="M71.17 60.26H29.88a1.91 1.91 0 0 0-1.3 3.31l26.53 24.76a4.17 4.17 0 0 0 2.85 1.13h23.38z"
      />
      <path
        fill={`url(#${gradientB})`}
        d="M33.34 6.54a4.12 4.12 0 0 0-3.95 2.88L4.25 83.92a4.14 4.14 0 0 0 3.91 5.54h20.79a4.44 4.44 0 0 0 3.4-2.9l5.02-14.78 17.91 16.7a4.24 4.24 0 0 0 2.67.97h23.29L71.02 60.26H41.24L59.47 6.55z"
      />
      <path
        fill={`url(#${gradientC})`}
        d="M66.6 9.36a4.14 4.14 0 0 0-3.93-2.82H33.65a4.15 4.15 0 0 1 3.93 2.82l25.18 74.62a4.15 4.15 0 0 1-3.93 5.48h29.02a4.15 4.15 0 0 0 3.93-5.48z"
      />
    </svg>
  );
};

export const BitbucketIcon: Icon = (props) => {
  const id = useId().replaceAll(":", "");
  const gradientId = `${id}-bitbucket-a`;

  return (
    <svg {...props} viewBox="8.4 14.39 2481.29 2231.21">
      <path fill="none" d="M989.97,1493.09h518.05l125.04-730.04H852.22L989.97,1493.09z" />
      <path
        fill="#2684FF"
        d="M88.92,14.4C45.02,13.83,8.97,48.96,8.41,92.86c-0.06,4.61,0.28,9.22,1.02,13.77l337.48,2048.72 c8.68,51.75,53.26,89.8,105.74,90.24h1619.03c39.38,0.5,73.19-27.9,79.49-66.78l337.49-2071.78c7.03-43.34-22.41-84.17-65.75-91.2 c-4.55-0.74-9.15-1.08-13.76-1.02L88.92,14.4z M1509.99,1495.09H993.24l-139.92-731h781.89L1509.99,1495.09z"
      />
      <linearGradient
        id={gradientId}
        gradientUnits="userSpaceOnUse"
        x1="945.1094"
        y1="1524.8389"
        x2="944.4923"
        y2="1524.1893"
        gradientTransform="matrix(1996.6343 0 0 -1480.3047 -1884485.625 2258195)"
      >
        <stop offset="0.18" stopColor="#0052CC" />
        <stop offset="1" stopColor="#2684FF" />
      </linearGradient>
      <path
        fill={`url(#${gradientId})`}
        d="M2379.27,763.06h-745.5l-125.12,730.42H992.31l-609.67,723.67c19.32,16.71,43.96,26,69.5,26.21h1618.13 c39.35,0.51,73.14-27.88,79.44-66.72L2379.27,763.06z"
      />
    </svg>
  );
};

export const CursorIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    viewBox="0 0 466.73 532.09"
    className={cn("fill-[#26251E] dark:fill-[#EDECEC]", className)}
  >
    <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
  </svg>
);

/** OpenCode's mark, as published in its ACP registry entry. */
export const OpenCodeIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 16 16" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="M13 14H3V2H13V14ZM10.5 4.4H5.5V11.6H10.5V4.4Z" />
  </svg>
);

/** Pi's one-color mark, from Pi's press kit. */
export const PiIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 560 560" fill="currentColor">
    <path d="M420 280H280V140H0V0H420V280ZM560 560H420V280H560V560ZM140 560H0V140H140V280H280V420H140V560Z" />
  </svg>
);

/** Meta's symbol, as Muse Code's own pages show it, in Meta blue. */
/** Muse's "M", redrawn as one stroke from Meta's Muse logo. */
export const MuseIcon: Icon = (props) => {
  const gradientId = `${useId().replaceAll(":", "")}-muse`;
  return (
    <svg {...props} viewBox="31 31 258 258" fill="none">
      <defs>
        <linearGradient
          id={gradientId}
          x1="60"
          y1="90"
          x2="270"
          y2="230"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#0056E6" />
          <stop offset="1" stopColor="#007BFB" />
        </linearGradient>
      </defs>
      <path
        d="M46 147C47.3 144.5 50.7 137.3 54 132C57.3 126.7 61.7 120.7 66 115C70.3 109.3 75.2 102.7 80 98C84.8 93.3 92.3 84.7 95 87C97.7 89.3 96.7 103.2 96 112C95.3 120.8 92.5 129.5 91 140C89.5 150.5 88.2 163 87 175C85.8 187 84.3 202.7 84 212C83.7 221.3 82.2 232.5 85 231C87.8 229.5 94.2 215.5 101 203C107.8 190.5 117.8 171.2 126 156C134.2 140.8 144.2 121.5 150 112C155.8 102.5 159 97 161 99C163 101 162.3 112.5 162 124C161.7 135.5 160 153.7 159 168C158 182.3 156.5 199.5 156 210C155.5 220.5 153.2 232 156 231C158.8 230 167 213.5 173 204C179 194.5 185.5 184.3 192 174C198.5 163.7 206.5 149.8 212 142C217.5 134.2 222.7 125.5 225 127C227.3 128.5 226.2 140.5 226 151C225.8 161.5 224.5 178.8 224 190C223.5 201.2 222.5 210.8 223 218C223.5 225.2 223.2 233 227 233C230.8 233 241 223.2 246 218C251 212.8 253.5 207 257 202C260.5 197 264.3 192.5 267 188C269.7 183.5 272 177.2 273 175"
        stroke={`url(#${gradientId})`}
        strokeWidth={27}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export const TraeIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="currentColor">
    {/* Back rectangle: left strip + bottom strip drawn separately — empty bottom-left corner is the gap between them */}
    <rect x="1" y="4" width="3" height="14" />
    <rect x="4" y="18" width="18" height="3" />
    {/* Front frame: top bar + right bar only — left and bottom are replaced by the back strips above */}
    <rect x="4" y="4" width="18" height="3" />
    <rect x="19" y="7" width="3" height="11" />
    {/* Two diamonds, offset slightly to the right within the open area */}
    <path d="M11 10L13 12L11 14L9 12Z" />
    <path d="M16 10L18 12L16 14L14 12Z" />
  </svg>
);

export const KiroIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 1200 1200" fill="none">
    <rect width="1200" height="1200" rx="260" fill="#9046FF" />
    <path
      d="M398.554 818.914C316.315 1001.03 491.477 1046.74 620.672 940.156C658.687 1059.66 801.052 970.473 852.234 877.795C964.787 673.567 919.318 465.357 907.64 422.374C827.637 129.443 427.623 128.946 358.8 423.865C342.651 475.544 342.402 534.18 333.458 595.051C328.986 625.86 325.507 645.488 313.83 677.785C306.873 696.424 297.68 712.819 282.773 740.645C259.915 783.881 269.604 867.113 387.87 823.883L399.051 818.914H398.554Z"
      fill="#fff"
    />
    <path
      d="M636.123 549.353C603.328 549.353 598.359 510.097 598.359 486.742C598.359 465.623 602.086 448.977 609.293 438.293C615.504 428.852 624.697 424.131 636.123 424.131C647.555 424.131 657.492 428.852 664.447 438.541C672.398 449.474 676.623 466.12 676.623 486.742C676.623 525.998 661.471 549.353 636.375 549.353H636.123Z"
      fill="#000"
    />
    <path
      d="M771.24 549.353C738.445 549.353 733.477 510.097 733.477 486.742C733.477 465.623 737.203 448.977 744.41 438.293C750.621 428.852 759.814 424.131 771.24 424.131C782.672 424.131 792.609 428.852 799.564 438.541C807.516 449.474 811.74 466.12 811.74 486.742C811.74 525.998 796.588 549.353 771.492 549.353H771.24Z"
      fill="#000"
    />
  </svg>
);

export const Zed: Icon = (props) => {
  const id = useId();
  const clipPathId = `${id}-zed-logo-a`;

  return (
    <svg {...props} fill="none" viewBox="0 0 96 96">
      <g clipPath={`url(#${clipPathId})`}>
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M9 6a3 3 0 0 0-3 3v66H0V9a9 9 0 0 1 9-9h80.379c4.009 0 6.016 4.847 3.182 7.682L43.055 57.187H57V51h6v7.688a4.5 4.5 0 0 1-4.5 4.5H37.055L26.743 73.5H73.5V36h6v37.5a6 6 0 0 1-6 6H20.743L10.243 90H87a3 3 0 0 0 3-3V21h6v66a9 9 0 0 1-9 9H6.621c-4.009 0-6.016-4.847-3.182-7.682L52.757 39H39v6h-6v-7.5a4.5 4.5 0 0 1 4.5-4.5h21.257l10.5-10.5H22.5V60h-6V22.5a6 6 0 0 1 6-6h52.757L85.757 6H9Z"
          clipRule="evenodd"
        />
      </g>
      <defs>
        <clipPath id={clipPathId}>
          <path fill="#fff" d="M0 0h96v96H0z" />
        </clipPath>
      </defs>
    </svg>
  );
};

export const OpenAI: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    preserveAspectRatio="xMidYMid"
    viewBox="0 0 256 260"
    className={cn("fill-black dark:fill-white", className)}
  >
    <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
  </svg>
);

export const ClaudeAI: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    preserveAspectRatio="xMidYMid"
    viewBox="0 0 256 257"
    className={cn("fill-[#d97757]", className)}
  >
    <path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" />
  </svg>
);

/** fx (https://fx.sh) wordmark glyph, from the official site logo. */
export const FxIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    preserveAspectRatio="xMidYMid"
    viewBox="166.241 0 155.861 156"
    className={cn("fill-black dark:fill-white", className)}
  >
    <path d="M237.89 0C243.18 0 249.38 1.42 253.03 3.07L255.09 4.01L250.08 18.63L247.68 17.75C244.9 16.72 241.94 15.8 238.49 15.8C234.98 15.8 232.79 16.56 231.08 18.32C229.23 20.23 227.63 23.64 226.23 29.76L226.23 29.76L226.23 29.76L225.14 34.85H241.67L260.43 34.95L260.69 34.95L260.84 35.17L278.85 61.63L296.74 34.95H320.87L291.68 76.74L322.1 119.75H299.33L299.18 119.55L241.14 40.48L239.35 49.4H222.07L205.69 127.21C203.93 135.71 201.19 142.84 196.78 147.87C192.27 153.01 186.2 155.75 178.34 155.75C174.18 155.75 170.75 155.11 167.91 154.11L166.24 153.52V137.18L166.9 137.4L169.53 138.28C172.18 139.16 174.41 139.8 177.14 139.8C178.53 139.8 179.7 139.53 180.73 138.98C181.76 138.43 182.68 137.6 183.52 136.44C185.3 133.99 186.72 130.13 187.9 124.67L203.76 49.4H189.87L191.76 39.44L192.04 39.35L206.82 34.47L208.15 28.64C210.52 18.21 213.77 10.94 218.71 6.32C223.74 1.61 230.13 0 237.89 0ZM273.99 99.08L260.07 120.25H234.54L261 82.02L273.99 99.08Z" />
  </svg>
);

/** Google Antigravity's full-color mark, from its press kit. */
export const AntigravityIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 128 128" fill="none">
    <image href={antigravityIconUrl} width="128" height="128" />
  </svg>
);

/** xAI's mark, for Grok Build. */
export const GrokIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 16 16" fill="currentColor">
    <path d="M0.58392448,14.9254204 L0.8326,14.66295 C2.004465,13.42985 3.1678,12.2082 2.45814,10.48105 C1.50813,8.1701 2.061355,5.4619 3.820575,3.70057 C5.6495,1.8709 8.3431,1.40957 10.59295,2.336505 C11.0907,2.52161 11.5245,2.785025 11.86295,3.02993 L9.98425,3.89849 C8.235,3.163775 6.23115,3.66355 5.0081,4.88809 C3.354105,6.5426 3.019895,9.4117 4.95835,11.2656 L-0.335,15.99995 C-0.066496,15.62975 0.2538896,15.275934 0.58392448,14.9254204 Z M14.0391,2.288155 L16.33165,2.57749377e-12 L16.20795,0.172288 C14.4658,2.574355 13.6153,3.749045 14.29795,6.6879 C14.76445,8.68415 14.261,10.90255 12.63545,12.53005 C10.5861,14.58325 7.3066,15.0403 4.6059,13.19215 L6.48885,12.3193 C8.2125,12.99705 10.0983,12.69945 11.4536,11.34255 C12.80895,9.9856 13.1133,8.00925 12.4321,6.3647 C12.30265,6.05285 11.9144,5.97455 11.64275,6.1753 L6.102,10.27035 L14.0391,2.288155 Z" />
  </svg>
);

/**
 * Grok Bot's own one-color mark: a ball with two slanted eyes, the glyph its
 * Mac app puts in the menu bar, redrawn from it (its dock icon is the same
 * face on a tile).
 */
export const GrokBotIcon: Icon = ({ className, ...props }) => {
  const maskId = `${useId().replaceAll(":", "")}-grok-bot`;
  return (
    <svg
      {...props}
      viewBox="0 0 36 36"
      className={cn("fill-[#141414] dark:fill-[#EDEDED]", className)}
    >
      <mask id={maskId}>
        <circle cx="18" cy="18" r="17" fill="#fff" />
        <rect
          x="17.9"
          y="8.1"
          width="3.6"
          height="8.8"
          rx="1.8"
          transform="rotate(-24 19.7 12.5)"
          fill="#000"
        />
        <rect
          x="25.9"
          y="4.6"
          width="2.8"
          height="8.8"
          rx="1.4"
          transform="rotate(-31 27.3 9)"
          fill="#000"
        />
      </mask>
      <circle cx="18" cy="18" r="17" mask={`url(#${maskId})`} />
    </svg>
  );
};

/**
 * A pull request the host is landing on its own: GitHub's own merge queue glyph
 * (one change on its way down to the base, two more waiting beside it), so the
 * badge reads the same here as on the pull request's page.
 *
 * From Primer Octicons (git-merge-queue-16), MIT licensed:
 * https://github.com/primer/octicons
 */
export const MergeQueueIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 16 16" fill="currentColor">
    <path d="M3.75 4.5a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5ZM3 7.75a.75.75 0 0 1 1.5 0v2.878a2.251 2.251 0 1 1-1.5 0Zm.75 5.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm5-7.75a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm5.75 2.5a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-1.5 0a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
  </svg>
);
