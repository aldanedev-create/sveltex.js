import { createApplication, token } from '@sveltex/core';
export const Message = token<string>('message');
export const app = createApplication({
  config: { name: 'example' },
  modules: [{ name: 'messages', providers: [{ provide: Message, useValue: 'SvelteX is ready.' }] }]
});
