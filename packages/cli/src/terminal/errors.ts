import { EXIT, type CliExitCode } from '../types/index.js';

export interface CliErrorOptions {
  readonly exitCode?: CliExitCode;
  readonly code?: string;
  readonly cause?: unknown;
  readonly details?: unknown;
}

/** A typed CLI failure carrying a stable code and a documented exit code. */
export class CliError extends Error {
  readonly exitCode: CliExitCode;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? EXIT.FAILED;
    this.code = options.code ?? 'SX_CLI_FAILED';
    this.details = options.details;
  }
}

export function usageError(message: string, code = 'SX_CLI_USAGE'): CliError {
  return new CliError(message, { exitCode: EXIT.USAGE, code });
}

export function projectError(message: string, code = 'SX_PROJECT_INVALID'): CliError {
  return new CliError(message, { exitCode: EXIT.PROJECT, code });
}

export function cancelled(message = 'Operation cancelled.'): CliError {
  return new CliError(message, { exitCode: EXIT.CANCELLED, code: 'SX_CANCELLED' });
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(message, { code: 'SX_CLI_UNEXPECTED', cause: error });
}
