import type { StandardSchemaV1 } from '@sveltex/validation';

/**
 * Hand-written Standard Schema v1 validators. `@sveltex/validation` is a
 * vendor-neutral executor, so the reference app supplies its own concrete
 * schemas rather than depending on Zod/Valibot/ArkType.
 */

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
}

export interface PostInput {
  readonly title: string;
  readonly body: string;
}

type Issue = { readonly message: string; readonly path: readonly (string | number)[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export const registerSchema: StandardSchemaV1<unknown, RegisterInput> = {
  '~standard': {
    version: 1,
    vendor: 'sveltex-reference-app',
    validate(value) {
      const issues: Issue[] = [];
      const obj = asObject(value);
      if (!obj) return { issues: [{ message: 'Registration payload must be an object.' }] };

      const email = obj['email'];
      if (typeof email !== 'string' || !EMAIL.test(email) || email.length > 320) {
        issues.push({ message: 'A valid email address is required.', path: ['email'] });
      }
      const password = obj['password'];
      // Aligns with AuthService's default minPasswordLength (12).
      if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
        issues.push({ message: 'Password must contain 12–1024 characters.', path: ['password'] });
      }
      const displayName = obj['displayName'];
      if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 120) {
        issues.push({ message: 'A display name (1–120 chars) is required.', path: ['displayName'] });
      }
      // Roles are NEVER accepted from user input — self-granting admin would be a
      // privilege escalation. Admin is granted only via trusted bootstrap config.
      if (issues.length > 0) return { issues };
      return { email: (email as string).trim().toLowerCase(), password: password as string, displayName: (displayName as string).trim() };
    },
  },
};

export const postSchema: StandardSchemaV1<unknown, PostInput> = {
  '~standard': {
    version: 1,
    vendor: 'sveltex-reference-app',
    validate(value) {
      const issues: Issue[] = [];
      const obj = asObject(value);
      if (!obj) return { issues: [{ message: 'Post payload must be an object.' }] };
      const title = obj['title'];
      if (typeof title !== 'string' || title.trim().length === 0 || title.length > 200) {
        issues.push({ message: 'Title must be 1–200 characters.', path: ['title'] });
      }
      const body = obj['body'];
      if (typeof body !== 'string' || body.trim().length === 0 || body.length > 10_000) {
        issues.push({ message: 'Body must be 1–10,000 characters.', path: ['body'] });
      }
      if (issues.length > 0) return { issues };
      return { title: (title as string).trim(), body: (body as string).trim() };
    },
  },
};
