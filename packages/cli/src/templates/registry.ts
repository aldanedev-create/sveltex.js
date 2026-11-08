export const TEMPLATE_IDS = ['minimal', 'fullstack', 'api', 'dashboard', 'saas', 'documentation'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const WELCOME_IDS = ['welcome', 'blank', 'dashboard', 'docs'] as const;
export type WelcomeId = (typeof WELCOME_IDS)[number];

/** Default documentation URL, overridable at generation time with --docs-url. */
export const OFFICIAL_DOCS_URL = 'https://sveltex.dev/docs';

export interface TemplateSpec {
  readonly id: TemplateId;
  readonly description: string;
  readonly defaultWelcome: WelcomeId;
  readonly welcomeChoices: readonly WelcomeId[];
  readonly sveltexPackages: readonly string[];
  readonly exampleRoutes: readonly string[];
  readonly features: readonly string[];
}

function spec(entry: TemplateSpec): TemplateSpec {
  return Object.freeze({
    ...entry,
    welcomeChoices: Object.freeze(entry.welcomeChoices),
    sveltexPackages: Object.freeze(entry.sveltexPackages),
    exampleRoutes: Object.freeze(entry.exampleRoutes),
    features: Object.freeze(entry.features),
  });
}

/** Six distinct starters; each has its own generated files and generation tests. */
export const TEMPLATES: readonly TemplateSpec[] = Object.freeze([
  spec({
    id: 'minimal',
    description: 'Smallest possible SvelteKit + SvelteX application',
    defaultWelcome: 'blank',
    welcomeChoices: ['blank', 'welcome'],
    sveltexPackages: ['core', 'sveltekit'],
    exampleRoutes: ['/'],
    features: ['One route', 'Core application with a single module', 'SvelteKit handle composed with sequence'],
  }),
  spec({
    id: 'fullstack',
    description: 'Recommended full-stack application with an editable welcome page',
    defaultWelcome: 'welcome',
    welcomeChoices: ['welcome', 'blank', 'dashboard', 'docs'],
    sveltexPackages: ['core', 'sveltekit', 'validation'],
    exampleRoutes: ['/', '/about', '/api/health'],
    features: ['Editable welcome page', 'DI module and service', 'JSON health endpoint', 'Standard Schema validation example'],
  }),
  spec({
    id: 'api',
    description: 'API-oriented SvelteKit application with no UI framework beyond a landing note',
    defaultWelcome: 'blank',
    welcomeChoices: ['blank', 'welcome'],
    sveltexPackages: ['core', 'sveltekit', 'validation'],
    exampleRoutes: ['/api/health', '/api/echo'],
    features: ['GET/POST endpoint examples', 'Request validation with Standard Schema', 'No client-side UI claims'],
  }),
  spec({
    id: 'dashboard',
    description: 'Dashboard application shell with example sections (UI only)',
    defaultWelcome: 'dashboard',
    welcomeChoices: ['dashboard', 'blank', 'welcome'],
    sveltexPackages: ['core', 'sveltekit'],
    exampleRoutes: ['/', '/reports', '/settings'],
    features: ['Responsive UI shell', 'Three navigable sections', 'Explicitly no auth or persistence'],
  }),
  spec({
    id: 'saas',
    description: 'SaaS foundation with optional auth/database/jobs integrations (none implied as configured)',
    defaultWelcome: 'blank',
    welcomeChoices: ['blank', 'welcome'],
    sveltexPackages: ['core', 'sveltekit', 'validation', 'jobs'],
    exampleRoutes: ['/', '/health'],
    features: ['Real in-memory job queue example', 'Health endpoint', 'No fake billing', 'No implied auth or durable persistence'],
  }),
  spec({
    id: 'documentation',
    description: 'Documentation website foundation with a sidebar and content routes',
    defaultWelcome: 'docs',
    welcomeChoices: ['docs', 'blank', 'welcome'],
    sveltexPackages: ['core', 'sveltekit'],
    exampleRoutes: ['/', '/docs/getting-started', '/docs/architecture'],
    features: ['Docs layout with sidebar', 'Two real content pages', 'No client-side JavaScript required'],
  }),
]);

export function isTemplateId(value: string): value is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(value);
}

export function isWelcomeId(value: string): value is WelcomeId {
  return (WELCOME_IDS as readonly string[]).includes(value);
}

export function getTemplate(id: TemplateId): TemplateSpec {
  const found = TEMPLATES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`Unknown template: ${id}`);
  return found;
}
