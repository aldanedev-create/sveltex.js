import { createApplication, defineModule, token, type InjectionToken } from '../../src/index.js';
interface Logger { log(message: string): void }
const LOGGER: InjectionToken<Logger> = token<Logger>('example.logger');
const logging = defineModule({ name: 'logging', providers: [{ provide: LOGGER, useValue: { log: (message: string) => void message } }], exports: [LOGGER] });
const app = createApplication({ config: { name: 'typed-app' }, modules: [logging] });
void app.start().then(async () => { const logger = await app.resolve(LOGGER); logger.log('ready'); await app.stop(); });

class ClockService { now(): Date { return new Date(); } }
class ReportService { constructor(readonly clock: ClockService) {} }
const reportModule = defineModule({
  name: 'reports',
  providers: [
    { provide: ClockService, useClass: ClockService },
    { provide: ReportService, useClass: ReportService, inject: [ClockService] },
  ],
});
void reportModule;
