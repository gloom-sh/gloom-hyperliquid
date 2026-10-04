import { hyperliquidPlugin as shared, setupShared } from "./src/plugin";
import { registerNativeCapabilities } from "./src/capability";
import { hyperliquidCli } from "./src/native/cli";
import { takeRuntimeDisposer } from "./src/runtime";
let disposeNative: (() => Promise<void>) | undefined;
export const hyperliquidPlugin = {
  ...shared,
  cliCommands: [hyperliquidCli],
  setup(ctx: Parameters<typeof setupShared>[0]) {
    setupShared(ctx);
    disposeNative = registerNativeCapabilities(ctx);
  },
  dispose() {
    const stop = disposeNative;
    disposeNative = undefined;
    const disposeMarket = takeRuntimeDisposer();
    // The host disposal API is synchronous. Keep transports until pending local
    // execution is journaled, and consume failures without exposing payloads.
    void Promise.resolve(stop?.())
      .finally(disposeMarket)
      .catch(() => {
        console.error(
          "Hyperliquid shutdown was incomplete. Inspect local TWAP state before resuming.",
        );
      });
  },
};
export { hyperliquidHeadless } from "./src/headless";
export default hyperliquidPlugin;
