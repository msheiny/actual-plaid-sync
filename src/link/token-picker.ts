import { emitKeypressEvents } from 'node:readline';
import { ConfigError } from '../config.js';
import { maskToken } from '../log.js';

interface Keypress {
  name?: string;
  ctrl?: boolean;
}

export interface TokenPickerIO {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

function choiceLine(token: string, index: number, selected: boolean): string {
  return `${selected ? '❯' : ' '} ${index + 1}. ${maskToken(token)}`;
}

/** Selects a token without ever printing its full secret value. */
export async function selectAccessToken(
  tokens: string[],
  io: TokenPickerIO = { input: process.stdin, output: process.stdout },
): Promise<string> {
  const first = tokens[0];
  if (tokens.length === 1 && first !== undefined) return first;
  if (tokens.length === 0) {
    throw new ConfigError([
      'PLAID_ACCESS_TOKENS (or LINK_ACCESS_TOKEN or --access-token) is required for link --update',
    ]);
  }
  if (!io.input.isTTY || !io.output.isTTY || !io.input.setRawMode) {
    throw new ConfigError([
      'PLAID_ACCESS_TOKENS contains multiple tokens; run `mise run link:update` in a terminal to choose one, or pass --access-token',
    ]);
  }

  const wasFlowing = io.input.readableFlowing === true;
  emitKeypressEvents(io.input);
  const wasRaw = io.input.isRaw;
  let selected = 0;

  const draw = (moveUp: boolean): void => {
    if (moveUp) io.output.write(`\x1b[${tokens.length}A`);
    for (const [index, token] of tokens.entries()) {
      io.output.write(`\r\x1b[2K${choiceLine(token, index, index === selected)}\n`);
    }
  };

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (result: string | Error): void => {
      if (settled) return;
      settled = true;
      io.input.off('keypress', onKeypress);
      io.input.off('end', onEnd);
      io.input.off('close', onClose);
      io.input.off('error', onError);
      try {
        io.input.setRawMode?.(wasRaw);
        if (!wasFlowing) io.input.pause();
        io.output.write('\x1b[?25h');
      } catch (err) {
        result = err instanceof Error ? err : new Error(String(err));
      }
      if (result instanceof Error) {
        io.output.write('\n');
        reject(result);
      } else {
        resolve(result);
      }
    };
    const onEnd = (): void => finish(new Error('Token selection cancelled: terminal input ended.'));
    const onClose = (): void =>
      finish(new Error('Token selection cancelled: terminal input closed.'));
    const onError = (err: Error): void => finish(err);
    const onKeypress = (_text: string, key: Keypress): void => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        finish(new Error('Token selection cancelled.'));
      } else if (key.name === 'escape') {
        finish(new Error('Token selection cancelled.'));
      } else if (key.name === 'up' || key.name === 'k') {
        selected = (selected - 1 + tokens.length) % tokens.length;
        draw(true);
      } else if (key.name === 'down' || key.name === 'j') {
        selected = (selected + 1) % tokens.length;
        draw(true);
      } else if (key.name === 'return' || key.name === 'enter') {
        const token = tokens[selected];
        if (token !== undefined) finish(token);
      }
    };
    io.input.on('keypress', onKeypress);
    io.input.once('end', onEnd);
    io.input.once('close', onClose);
    io.input.once('error', onError);
    try {
      io.output.write('Choose the bank token to update (use ↑/↓ and Enter):\n');
      io.output.write('\x1b[?25l');
      draw(false);
      io.input.setRawMode?.(true);
      io.input.resume();
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
