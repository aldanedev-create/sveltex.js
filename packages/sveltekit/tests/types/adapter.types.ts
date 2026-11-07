import { createApplication, token } from '@sveltex/core';
import {
  createSvelteXHandler,
  defineSvelteXKitConfig,
  getSvelteXContext,
  type Handle,
  type SvelteXRequestContext
} from '../../src/index.js';

interface CurrentUser { readonly id: string; }
const CurrentUserToken = token<CurrentUser | null>('types.current-user');
const application = createApplication({
  config: { name: 'types-test' },
  modules: [{ name: 'users', providers: [{ provide: CurrentUserToken, scope: 'request', useValue: null }] }]
});

const options = defineSvelteXKitConfig({ localsKey: 'services', autoStart: false });
const handle: Handle = createSvelteXHandler(application, options);
void handle;

function consumeContext(context: SvelteXRequestContext): void {
  const promise: Promise<CurrentUser | null> = context.resolve(CurrentUserToken);
  void promise;
}

function consumeLocals(locals: object): void {
  const context = getSvelteXContext(locals, 'services');
  consumeContext(context);
}

void consumeLocals;
