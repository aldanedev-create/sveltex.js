import { createApplication, token } from '@sveltex/core';
export const SERVICE = token('test.request-service');
export function makeApplication({ dispose } = {}) {
  return createApplication({ config: { name: 'adapter-test' }, modules: [{ name: 'test', providers: [{ provide: SERVICE, scope: 'request', useFactory: () => ({ id: Symbol('request'), dispose }) }] }] });
}
export function makeEvent(path = '/') {
  const url = new URL(path, 'http://localhost');
  return { request: new Request(url), url, locals: {}, params: {} };
}
export const resolveOk = async () => new Response('ok', { status: 200 });
