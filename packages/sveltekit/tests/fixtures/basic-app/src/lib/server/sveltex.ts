import { createApplication, token } from '@sveltex/core';
export const HealthMessage = token<string>('health-message');
export const app = createApplication({
  config: { name: 'sveltekit-fixture' },
  modules: [{ name: 'health', providers: [{ provide: HealthMessage, useValue: 'ok' }] }]
});
