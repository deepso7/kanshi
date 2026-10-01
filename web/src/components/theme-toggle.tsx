import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { ThemePreference } from "../theme/preference.ts";
import { themePreferences } from "../theme/preference.ts";
import { useTheme } from "../theme/theme-provider.tsx";
import { colors, motion, radius } from "../theme/tokens.stylex.ts";
import { MonitorIcon, MoonIcon, SunIcon } from "./ui/icons.tsx";
import { shared } from "./ui/shared.ts";

const styles = stylex.create({
  group: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    display: "inline-flex",
    gap: "1px",
    padding: "1px",
  },
  item: {
    alignItems: "center",
    backgroundColor: {
      ":hover": colors.accent,
      ":is([data-pressed])": colors.secondaryHover,
      default: "transparent",
    },
    borderRadius: radius.sm,
    borderStyle: "none",
    color: {
      ":hover": colors.foreground,
      ":is([data-pressed])": colors.foreground,
      default: colors.mutedForeground,
    },
    cursor: "pointer",
    display: "inline-flex",
    height: "1.75rem",
    justifyContent: "center",
    padding: 0,
    transitionDuration: motion.fast,
    transitionProperty: "background-color, color",
    width: "1.75rem",
  },
});

const options = {
  dark: { icon: <MoonIcon />, label: "Dark theme" },
  light: { icon: <SunIcon />, label: "Light theme" },
  system: { icon: <MonitorIcon />, label: "System theme" },
} satisfies Record<ThemePreference, { icon: ReactNode; label: string }>;

/** System / light / dark, stored in localStorage. */
export const ThemeToggle = ({
  style,
}: {
  readonly style?: stylex.StyleXStyles;
}) => {
  const { preference, setPreference } = useTheme();
  return (
    <ToggleGroup
      aria-label="Theme"
      onValueChange={(value) => {
        // Pressing the active one again would empty the group: keep it.
        const next = themePreferences.find((option) => value.includes(option));
        if (next !== undefined) {
          setPreference(next);
        }
      }}
      value={[preference]}
      {...stylex.props(styles.group, style)}
    >
      {themePreferences.map((option) => (
        <Toggle
          aria-label={options[option].label}
          key={option}
          title={options[option].label}
          value={option}
          {...stylex.props(styles.item, shared.focusRing)}
        >
          {options[option].icon}
        </Toggle>
      ))}
    </ToggleGroup>
  );
};
