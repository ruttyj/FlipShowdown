import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { App } from '../../src/providers/App.js';
import { BaseProvider } from '../../src/providers/BaseProvider.js';

// The App container on its own: lazy parts, the register-then-boot start and the reverse-order
// shutdown. providers.test covers the server's own providers.

/** A provider that records each step it runs in `steps` as "<name>.<step>". */
class RecordingProvider extends BaseProvider {
    constructor(name, steps, { shutdown } = {}) {
        super();
        this.name = name;
        this.steps = steps;
        this.shutdownStep = shutdown;
    }

    register() {
        this.steps.push(`${this.name}.register`);
    }

    boot() {
        this.steps.push(`${this.name}.boot`);
    }

    shutdown() {
        this.steps.push(`${this.name}.shutdown`);
        return this.shutdownStep?.();
    }
}

describe('App', () => {
    describe('parts', () => {
        test('a part is built on its first get, once, with the app as the argument', () => {
            const app = new App({ port: 1 }, { logger: null });
            const calls = [];
            app.register('thing', (received) => {
                calls.push(received);
                return { built: calls.length };
            });
            assert.deepEqual(calls, []);

            const first = app.get('thing');
            const second = app.get('thing');

            assert.equal(first, second);
            assert.deepEqual(calls, [app]);
            assert.deepEqual(app.config, { port: 1 });
            assert.deepEqual(app.options, { logger: null });
        });

        test('a falsy part is still built only once', () => {
            const app = new App({});
            let calls = 0;
            app.register('nothing', () => {
                calls += 1;
                return null;
            });

            assert.equal(app.get('nothing'), null);
            assert.equal(app.get('nothing'), null);
            assert.equal(calls, 1);
        });

        test('a part may ask for one registered after it', () => {
            const app = new App({});
            app.register('greeting', () => `hello ${app.get('name')}`);
            app.register('name', () => 'Ann');

            assert.equal(app.get('greeting'), 'hello Ann');
        });

        test('options default to an empty object', () => {
            assert.deepEqual(new App({}).options, {});
        });

        test('get throws for a name nobody registered', () => {
            const app = new App({});
            assert.throws(() => app.get('missing'), { message: 'Nothing registered as missing' });
        });

        test('register throws for a name that is already taken', () => {
            const app = new App({});
            app.register('thing', () => 1);
            assert.throws(() => app.register('thing', () => 2), { message: 'Already registered: thing' });
            assert.equal(app.get('thing'), 1);
        });

        test('a part that needs itself is a dependency cycle, not a stack overflow', () => {
            const app = new App({});
            app.register('first', () => app.get('second'));
            app.register('second', () => app.get('first'));

            assert.throws(() => app.get('first'), { message: 'Dependency cycle while building first' });
        });

        test('a factory that throws can be retried', () => {
            const app = new App({});
            let isReady = false;
            app.register('flaky', () => {
                if (!isReady) {
                    throw new Error('not yet');
                }
                return 'ready';
            });

            assert.throws(() => app.get('flaky'), { message: 'not yet' });
            isReady = true;
            assert.equal(app.get('flaky'), 'ready');
        });
    });

    describe('start and close', () => {
        test('start registers every provider before booting any, in the order added', () => {
            const steps = [];
            const app = new App({});
            app.addProvider(new RecordingProvider('a', steps));
            app.addProvider(new RecordingProvider('b', steps));

            app.start();

            assert.deepEqual(steps, ['a.register', 'b.register', 'a.boot', 'b.boot']);
        });

        test('close shuts down in reverse order and waits for each provider', async () => {
            const steps = [];
            const app = new App({});
            const slowShutdown = () => new Promise((resolve) => {
                setTimeout(() => {
                    steps.push('b.finished');
                    resolve();
                }, 5);
            });
            app.addProvider(new RecordingProvider('a', steps));
            app.addProvider(new RecordingProvider('b', steps, { shutdown: slowShutdown }));
            app.addProvider(new RecordingProvider('c', steps));
            app.start();
            steps.length = 0;

            await app.close();

            assert.deepEqual(steps, ['c.shutdown', 'b.shutdown', 'b.finished', 'a.shutdown']);
        });

        test('close runs synchronous shutdowns before it returns, up to the first promise', async () => {
            const steps = [];
            const app = new App({});
            const slowShutdown = () => new Promise((resolve) => {
                setTimeout(resolve, 5);
            });
            app.addProvider(new RecordingProvider('a', steps));
            app.addProvider(new RecordingProvider('b', steps, { shutdown: slowShutdown }));
            app.addProvider(new RecordingProvider('c', steps));
            app.addProvider(new RecordingProvider('d', steps));
            app.start();
            steps.length = 0;

            const closing = app.close();

            assert.deepEqual(steps, ['d.shutdown', 'c.shutdown', 'b.shutdown']);
            assert.ok(closing instanceof Promise);
            await closing;
            assert.deepEqual(steps, ['d.shutdown', 'c.shutdown', 'b.shutdown', 'a.shutdown']);
        });

        test('a BaseProvider does nothing at every step', async () => {
            const app = new App({});
            app.addProvider(new BaseProvider());

            app.start();
            await app.close();

            assert.throws(() => app.get('anything'), { message: 'Nothing registered as anything' });
        });
    });
});
