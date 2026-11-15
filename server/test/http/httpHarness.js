import http from 'node:http';
import express from 'express';

// Shared setup for the http/ unit tests (this file contains no tests of its own): a fake Express
// response for calling middleware directly, and a real Express app on an ephemeral port for
// driving a controller through its routes.

/**
 * A stand-in for an Express response that records what a middleware wrote: `statusCode`, `body`
 * (from json), `ended` and `headersSent`, which is true once json or end has run (tests may also
 * set it first).
 */
export function fakeResponse() {
    const res = {
        statusCode: 200,
        body: undefined,
        ended: false,
        headersSent: false,
        status(code) {
            res.statusCode = code;
            return res;
        },
        json(body) {
            res.body = body;
            res.headersSent = true;
            return res;
        },
        end() {
            res.ended = true;
            res.headersSent = true;
            return res;
        },
    };
    return res;
}

/** A `next` that records the arguments of every call in `next.calls`. */
export function recordingNext() {
    const next = (...args) => {
        next.calls.push(args);
    };
    next.calls = [];
    return next;
}

/** Express middleware that sets req.user, standing in for requireUser. */
export function signedInAs(user) {
    return (req, res, next) => {
        req.user = user;
        next();
    };
}

/**
 * Serves an Express app on 127.0.0.1 after `configure(app)` adds its routes. Every error reaches a
 * final handler that answers 500 with { message: error.message }. Returns { request, close }:
 * request(method, path, { body, headers }) sends `body` as JSON (or as-is when it is a string) and
 * resolves to { status, headers, text, body }, where body is the parsed JSON or null.
 */
export async function serveApp(configure) {
    const app = express();
    configure(app);
    // Express recognises error handlers by their four parameters.
    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => {
        res.status(500).json({ message: error.message });
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    async function request(method, path, { body, headers = {} } = {}) {
        const init = { method, headers: { ...headers }, redirect: 'manual' };
        if (typeof body === 'string') {
            init.body = body;
        } else if (body !== undefined) {
            init.body = JSON.stringify(body);
            init.headers['content-type'] = 'application/json';
        }

        const response = await fetch(`${baseUrl}${path}`, init);
        const text = await response.text();
        let parsed = null;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = null;
        }
        return { status: response.status, headers: response.headers, text, body: parsed };
    }

    return {
        request,
        close() {
            return new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
