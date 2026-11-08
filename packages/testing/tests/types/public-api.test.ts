import {
  FakeClock,
  LifecycleRecorder,
  TestApplication,
  createTestApplication,
  withTestApplication,
  createRequestFixture,
  defineTestModule,
  testToken,
  createValueProvider,
  createFactoryProvider,
  createClassProvider,
  FakeKeyValueAdapter,
  FakeMessageTransport,
  TestingError,
  TestSetupError,
} from '../../dist/index.js';
import type {
  LifecycleEvent,
  TestApplicationOptions,
  RequestFixture,
  FakeCall,
  CallRecorder,
  FakeSentMessage,
  TestingErrorOptions,
} from '../../dist/index.js';

type Widget = { readonly id: number; readonly label: string };
const WIDGET = testToken<Widget>('widget');

// ---- deterministic clock ----
const clock: FakeClock = new FakeClock(10);
const now: number = clock.now();
const advanced: number = clock.advance(5);
void [now, advanced];

// @ts-expect-error start must be a number
void new FakeClock('no');
// @ts-expect-error advance requires a number
void clock.advance('no');

// ---- recorder ----
const recorder: LifecycleRecorder = new LifecycleRecorder(() => clock.now());
const asCallRecorder: CallRecorder = recorder; // LifecycleRecorder implements CallRecorder
void asCallRecorder;
recorder.record('get', 'FakeKeyValueAdapter');
const lifecycle: LifecycleRecorder = new LifecycleRecorder();
const evt: LifecycleEvent = { phase: 'start', label: 'a', at: 0 };
const phases: readonly string[] = lifecycle.phases();
const events: readonly LifecycleEvent[] = lifecycle.events;
void [evt, phases, events];

// ---- tokens & providers (real core Provider shapes) ----
const vp = createValueProvider<Widget>(WIDGET, { id: 1, label: 'a' });
const fp = createFactoryProvider<Widget>(WIDGET, () => ({ id: 2, label: 'b' }), 'singleton');
class Service { greet(): string { return 'hi'; } }
const SERVICE = testToken<Service>('service');
const cp = createClassProvider<Service>(SERVICE, Service);
void [vp, fp, cp];

// @ts-expect-error useValue must match Widget
void createValueProvider<Widget>(WIDGET, { id: 'wrong' });
// @ts-expect-error scope must be a ProviderScope
void createFactoryProvider<Widget>(WIDGET, () => ({ id: 1, label: 'x' }), 'yearly');
// @ts-expect-error a class provider needs a Constructor<T>
void createClassProvider<Service>(SERVICE, { notAClass: true });

// ---- modules ----
const mod = defineTestModule({ name: 'widgets', providers: [vp], exports: [WIDGET] }, lifecycle);
void mod;
// @ts-expect-error a module needs a name
void defineTestModule({});

// ---- application builder ----
const options: TestApplicationOptions = { config: { name: 'spec-app' }, modules: [mod], clock, recorder };
const app: TestApplication = createTestApplication(options);
const started: Promise<TestApplication> = app.start();
const stopped: Promise<void> = app.stop();
const value: Promise<Widget> = app.resolve<Widget>(WIDGET);
const fixture: RequestFixture = app.fixture();
const resolved: Promise<Widget> = fixture.resolve<Widget>(WIDGET);
const disposed: Promise<void> = fixture.dispose();
const isDisposed: boolean = fixture.disposed;
void [started, stopped, value, resolved, disposed, isDisposed];

const result: Promise<number> = withTestApplication(async (a) => (a.state === 'running' ? 1 : 0));
void result;
// @ts-expect-error withTestApplication requires a callback
void withTestApplication(42);

// createRequestFixture takes a real core Application
const direct: RequestFixture = createRequestFixture(app.app);
void direct;

// @ts-expect-error modules must be ModuleDefinitions
void createTestApplication({ modules: [42] });

// ---- fakes ----
const kv = new FakeKeyValueAdapter({ recorder });
const calls: readonly FakeCall[] = kv.calls;
const got: Promise<Widget | undefined> = kv.get<Widget>('k');
const snap: Readonly<Record<string, unknown>> = kv.snapshot();
const closed: boolean = kv.isClosed;
void [calls, got, snap, closed];

const transport = new FakeMessageTransport<Widget>({ recorder, clock: () => clock.now() });
const sent: readonly FakeSentMessage<Widget>[] = transport.sent;
const sendResult: Promise<void> = transport.send({ id: 3, label: 'c' });
void [sent, sendResult];

// ---- errors ----
const opts: TestingErrorOptions = { details: { a: 1 } };
const e1: TestingError = new TestingError('x', opts);
const e2: TestSetupError = new TestSetupError('y');
const code: string = e1.code;
void [code, e2];
