export interface StandardSchemaIssue { readonly message: string; readonly path?: readonly (string | number | { readonly key: string | number })[]; }
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': { readonly version: 1; readonly vendor: string; readonly validate: (value: unknown) => Output | { readonly issues: readonly StandardSchemaIssue[] } | Promise<Output | { readonly issues: readonly StandardSchemaIssue[] }>; readonly types?: { readonly input: Input; readonly output: Output } };
}
export type ValidationIssue = { readonly message: string; readonly path: readonly (string | number)[] };
export type ValidationResult<T> = { readonly success: true; readonly data: T } | { readonly success: false; readonly issues: readonly ValidationIssue[] };

export class ValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(issues: readonly ValidationIssue[]) {
    const safeIssues = normalizeIssues(issues);
    super(safeIssues.map(issue => issue.message).join('; ') || 'Validation failed');
    this.name = 'ValidationError';
    this.issues = safeIssues;
  }
}

/** Executes a Standard Schema v1 validator and safely normalizes its result. */
export async function safeValidate<Input, Output>(schema: StandardSchemaV1<Input, Output>, input: Input): Promise<ValidationResult<Output>> {
  const standard = schema?.['~standard'];
  if (!standard || standard.version !== 1 || typeof standard.vendor !== 'string' || !standard.vendor || typeof standard.validate !== 'function') {
    throw new TypeError('A valid Standard Schema v1 implementation is required.');
  }
  let result: unknown;
  try { result = await standard.validate(input); }
  catch (cause) { throw new ValidationExecutionError(cause); }
  if (isIssueResult(result)) return { success: false, issues: normalizeIssues(result.issues) };
  return { success: true, data: result as Output };
}

export async function validate<Input, Output>(schema: StandardSchemaV1<Input, Output>, input: Input): Promise<Output> {
  const result = await safeValidate(schema, input);
  if (!result.success) throw new ValidationError(result.issues);
  return result.data;
}

export function formatValidationIssues(issues: readonly ValidationIssue[]): string {
  return normalizeIssues(issues).map(issue => `${issue.path.length ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`).join('\n');
}

export class ValidationExecutionError extends Error {
  constructor(cause: unknown) { super('The validation schema failed while executing.', { cause }); this.name = 'ValidationExecutionError'; }
}

function isIssueResult(value: unknown): value is { readonly issues: readonly StandardSchemaIssue[] } {
  return typeof value === 'object' && value !== null && 'issues' in value && Array.isArray((value as { issues?: unknown }).issues);
}
function normalizeIssues(issues: readonly StandardSchemaIssue[]): readonly ValidationIssue[] {
  if (!Array.isArray(issues)) throw new TypeError('Validation issues must be an array.');
  return Object.freeze(issues.map(issue => {
    if (!issue || typeof issue.message !== 'string') throw new TypeError('Each validation issue must contain a string message.');
    const path = issue.path ?? [];
    if (!Array.isArray(path)) throw new TypeError('Validation issue paths must be arrays.');
    const normalized = path.map(part => {
      const key = typeof part === 'object' && part !== null && 'key' in part ? part.key : part;
      if (typeof key !== 'string' && typeof key !== 'number') throw new TypeError('Validation issue path segments must be strings or numbers.');
      if (typeof key === 'number' && !Number.isFinite(key)) throw new TypeError('Validation issue path numbers must be finite.');
      return key;
    });
    return Object.freeze({ message: issue.message, path: Object.freeze(normalized) });
  }));
}
