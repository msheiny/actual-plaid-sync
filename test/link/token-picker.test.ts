import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../src/config.js';
import { selectAccessToken, type TokenPickerIO } from '../../src/link/token-picker.js';

function terminalIO(): {
  io: TokenPickerIO;
  input: PassThrough;
  output: PassThrough;
  text: string[];
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const text: string[] = [];
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode: vi.fn() });
  Object.assign(output, { isTTY: true });
  output.on('data', (chunk) => text.push(String(chunk)));
  return {
    io: {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    },
    input,
    output,
    text,
  };
}

describe('selectAccessToken', () => {
  it('returns a sole token without requiring a terminal', async () => {
    await expect(selectAccessToken(['access-sandbox-only'])).resolves.toBe('access-sandbox-only');
  });

  it('uses arrow keys and Enter to choose while only displaying masked tokens', async () => {
    const { io, input, text } = terminalIO();
    const selected = selectAccessToken(
      ['access-sandbox-secret-one1111', 'access-sandbox-secret-two2222'],
      io,
    );

    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'return' });

    await expect(selected).resolves.toBe('access-sandbox-secret-two2222');
    const screen = text.join('');
    expect(screen).toContain('…1111');
    expect(screen).toContain('…2222');
    expect(screen).toContain('1.');
    expect(screen).toContain('2.');
    expect(screen).not.toContain('access-sandbox-secret');
    expect(input.isPaused()).toBe(true);
  });

  it('cancels and restores terminal state when input ends', async () => {
    const { io, input } = terminalIO();
    const selected = selectAccessToken(['token-one', 'token-two'], io);

    input.emit('end');

    await expect(selected).rejects.toThrow('terminal input ended');
    expect(io.input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('rejects multiple tokens when no interactive terminal is available', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    await expect(
      selectAccessToken(['token-one', 'token-two'], {
        input: input as unknown as NodeJS.ReadStream,
        output: output as unknown as NodeJS.WriteStream,
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
