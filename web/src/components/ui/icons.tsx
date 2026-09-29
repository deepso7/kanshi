// Small stroke icons (16px grid, currentColor). Decorative by default:
// label the control that holds them, not the icon.
import type { ComponentProps } from "react";

type IconProps = Omit<ComponentProps<"svg">, "children">;

const Icon = ({ children, ...props }: ComponentProps<"svg">) => (
  <svg
    aria-hidden
    fill="none"
    focusable="false"
    height="16"
    stroke="currentColor"
    strokeLinecap="square"
    strokeWidth="1.5"
    viewBox="0 0 16 16"
    width="16"
    {...props}
  >
    {children}
  </svg>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 8.5 6.5 12 13 4.5" />
  </Icon>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4 6 4 4 4-4" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);

export const MinusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 8h8" />
  </Icon>
);

export const SunIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect height="5" width="5" x="5.5" y="5.5" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </Icon>
);

export const MoonIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" />
  </Icon>
);

export const MonitorIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect height="8" width="12" x="2" y="2.5" />
    <path d="M5.5 13.5h5M8 10.5v3" />
  </Icon>
);

export const MoreIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.5" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);
