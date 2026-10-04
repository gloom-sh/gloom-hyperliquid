import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';
import { parseCliArgs, readSecretKey, redactCliError } from './cli-input';

test('CLI requires explicit network and never accepts inline credentials', () => {
  expect(() => parseCliArgs(['status'])).toThrow('Choose --network');
  expect(() => parseCliArgs(['import-key', '--network', 'testnet', '--private-key', generatePrivateKey()])).toThrow('Unknown or duplicate');
  expect(() => parseCliArgs(['order', '--network', 'testnet', '--key-file', '/unused'])).toThrow('only accepted');
  expect(() => parseCliArgs(['status', '--network', 'testnet', '--network', 'mainnet'])).toThrow('duplicate');
  expect(parseCliArgs(['cancel', '--network', 'testnet', '--all', '--yes']).flags.all).toBe(true);
});

test('native key reader rejects public permissions and symlinks without printing contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hl-cli-secret-'));
  const path = join(dir, 'key'), link = join(dir, 'link');
  const key = generatePrivateKey();
  try {
    await writeFile(path, key, { mode: 0o600 });
    expect(await readSecretKey({ 'key-file': path })).toBe(key);
    await chmod(path, 0o644);
    await expect(readSecretKey({ 'key-file': path })).rejects.toThrow('owner-only');
    await chmod(path, 0o600); await symlink(path, link);
    await expect(readSecretKey({ 'key-file': link })).rejects.toThrow('no symlink');
    await expect(readSecretKey({ 'key-file': path, 'key-stdin': true })).rejects.toThrow('exactly one');
    await writeFile(path, 'not a private key');
    await expect(readSecretKey({ 'key-file': path })).rejects.toThrow('hexadecimal private key');
    expect(redactCliError(new Error(`Invalid: ${key}`))).not.toContain(key);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
