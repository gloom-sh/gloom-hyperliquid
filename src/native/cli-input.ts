import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Network } from '../trading/types';

const switches = new Set(['yes', 'json', 'acknowledge-risk', 'eligible', 'key-stdin', 'reduce-only', 'all']);
const options = new Set(['network', 'key-file', 'address', 'expires-at', 'market', 'side', 'kind', 'size', 'unit', 'price', 'tif', 'leverage', 'margin-mode', 'client-id', 'oid', 'percent', 'approval-port', 'slippage-bps']);
export type CliArgs = { command: string; flags: Record<string, string | true>; network: Network };
export function parseCliArgs(args: string[]): CliArgs {
  const command = args[0] || 'status';
  if (!['status', 'account', 'import-key', 'connect-key', 'connect', 'wallet', 'disconnect', 'preview', 'order', 'cancel', 'close'].includes(command)) throw new Error('Unknown Hyperliquid command. See gloomberb help hyperliquid.');
  const flags: CliArgs['flags'] = {};
  for (let i = 1; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith('--')) throw new Error('Use named options. Private keys must come from a file or piped stdin.');
    const name = token.slice(2);
    if (name in flags || (!switches.has(name) && !options.has(name))) throw new Error('Unknown or duplicate option. See gloomberb help hyperliquid.');
    if (switches.has(name)) flags[name] = true;
    else { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('An option value is missing.'); flags[name] = value; }
  }
  if (flags.network !== 'mainnet' && flags.network !== 'testnet') throw new Error('Choose --network mainnet or --network testnet explicitly.');
  if ((flags['key-file'] || flags['key-stdin']) && !['import-key', 'connect-key'].includes(command)) throw new Error('Key input is only accepted by import-key and connect-key.');
  return { command, flags, network: flags.network };
}

/** Open once with O_NOFOLLOW and inspect the open descriptor before reading. */
export async function readSecretKey(flags: CliArgs['flags']): Promise<`0x${string}`> {
  if (Boolean(flags['key-file']) === Boolean(flags['key-stdin'])) throw new Error('Choose exactly one of --key-file PATH or --key-stdin. Never pass a key as an argument.');
  let value = '';
  if (typeof flags['key-file'] === 'string') {
    let file;
    try {
      file = await open(flags['key-file'], constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 256 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
      value = (await file.readFile('utf8')).trim();
    } catch { throw new Error('Key file must be a small owner-only regular file owned by this user (chmod 600), with no symlink.'); }
    finally { await file?.close(); }
  } else {
    if (process.stdin.isTTY) throw new Error('Pipe key input; interactive stdin would echo the secret.');
    for await (const chunk of process.stdin) { value += chunk.toString(); if (value.length > 256) throw new Error('Invalid key input.'); }
    value = value.trim();
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Expected one hexadecimal private key in the input, never a recovery phrase.');
  return value as `0x${string}`;
}

export function redactCliError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Hyperliquid command failed.').replace(/(?:0x)?[0-9a-fA-F]{64}/g, '[redacted]').slice(0, 600);
}
