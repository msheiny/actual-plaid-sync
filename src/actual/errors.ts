// Kept free of @actual-app/api imports so the CLI can recognize this error without loading the SDK.
export class ActualError extends Error {
  readonly code: string | null;
  readonly hint: string;

  constructor(message: string, code: string | null, hint: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ActualError';
    this.code = code;
    this.hint = hint;
  }
}
