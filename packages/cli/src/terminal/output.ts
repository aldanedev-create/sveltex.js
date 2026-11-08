import { EXIT, type CliExitCode, type CliResult, type CommandOutcome, type LogLevel, type LogMessage, type Reporter } from '../types/index.js';
import { CliError } from './errors.js';

const PREFIX: Readonly<Record<LogLevel, string>> = {
  info: '[info]',
  warn: '[warn]',
  error: '[error]',
  success: '[ ok ]',
};

export type WriteLine = (line: string) => void;

export class DefaultReporter implements Reporter {
  readonly json: boolean;
  readonly #messages: LogMessage[] = [];
  readonly #out: WriteLine;
  readonly #err: WriteLine;
  #data: unknown = null;

  constructor(json: boolean, out: WriteLine = (line) => process.stdout.write(`${line}\n`), err: WriteLine = (line) => process.stderr.write(`${line}\n`)) {
    this.json = json;
    this.#out = out;
    this.#err = err;
  }

  get messages(): readonly LogMessage[] {
    return Object.freeze([...this.#messages]);
  }

  get data(): unknown {
    return this.#data;
  }

  #log(level: LogLevel, message: string): void {
    this.#messages.push({ level, message });
    if (!this.json) {
      const line = `${PREFIX[level]} ${message}`;
      if (level === 'error' || level === 'warn') this.#err(line);
      else this.#out(line);
    }
  }

  info(message: string): void { this.#log('info', message); }
  warn(message: string): void { this.#log('warn', message); }
  error(message: string): void { this.#log('error', message); }
  success(message: string): void { this.#log('success', message); }

  result(data: unknown): void {
    this.#data = data;
  }
}

export interface BuildResultOptions {
  readonly command: string | undefined;
  readonly outcome: CommandOutcome | undefined;
  readonly reporter: Reporter;
  readonly exitCode: CliExitCode;
  readonly error?: CliError;
}

export function buildResult(options: BuildResultOptions): CliResult {
  const { command, outcome, reporter, exitCode, error } = options;
  const base: CliResult = {
    exitCode,
    command,
    ok: exitCode === EXIT.OK,
    data: outcome?.data ?? (error === undefined ? null : { code: error.code }),
    messages: reporter.messages,
    ...(error !== undefined ? { error: { code: error.code, message: error.message } } : {}),
  };
  return Object.freeze(base);
}

/** Serialize a result for a terminal. JSON mode emits exactly one JSON object; human lines were already emitted by the reporter. */
export function renderResult(result: CliResult, json: boolean): string {
  return json ? JSON.stringify(result) : '';
}
