import type { GloomPlugin } from "gloomberb/types/plugin";

export const hyperliquidPlugin: GloomPlugin = {
  id: "hyperliquid",
  name: "Hyperliquid",
  version: "0.1.0",
  description: "Hyperliquid perpetual futures board and trading",
  homepage: "https://github.com/gloom-sh/gloom-hyperliquid",
  toggleable: true,
  targets: ["cli", "tui", "desktop"],
  hosts: ["api.hyperliquid.xyz"],
};

export default hyperliquidPlugin;
