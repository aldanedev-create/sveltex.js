import type { Application } from '@sveltex/core';
import { createSvelteXHandler } from '../application/create-sveltex-handler.js';
import type { SvelteXHandlerOptions } from '../types/config.types.js';
export function createHandler(application: Application, options?: SvelteXHandlerOptions) { return createSvelteXHandler(application, options); }
