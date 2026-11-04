export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
    readonly uncertain = false,
    readonly recovery?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function usage(message: string): never {
  throw new CliError("USAGE", message, 2);
}

export function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
