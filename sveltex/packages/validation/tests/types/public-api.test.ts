import { safeValidate, validate, type StandardSchemaV1 } from '../../dist/index.js';
const schema: StandardSchemaV1<string, number> = { '~standard': { version: 1, vendor: 'type-test', validate: value => typeof value === 'string' ? Number(value) : { issues: [{ message: 'string required' }] } } };
const parsed: Promise<number> = validate(schema, '42');
const safe: ReturnType<typeof safeValidate<string, number>> = safeValidate(schema, '42');
void [parsed, safe];
