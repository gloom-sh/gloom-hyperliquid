import { hyperliquidPlugin as shared, setupShared } from './src/plugin';
import { registerNativeCapabilities } from './src/capability';
import { hyperliquidCli } from './src/native/cli';
let disposeNative: (() => void) | undefined;
export const hyperliquidPlugin = {
  ...shared,
  cliCommands: [hyperliquidCli],
  setup(ctx: Parameters<typeof setupShared>[0]) { setupShared(ctx); disposeNative = registerNativeCapabilities(ctx); },
  dispose() { disposeNative?.(); disposeNative = undefined; shared.dispose?.(); },
};
export { hyperliquidHeadless } from './src/headless';
export default hyperliquidPlugin;
