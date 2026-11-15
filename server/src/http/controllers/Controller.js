import express from 'express';

// What the routed controllers extend. A controller's routes(router) adds its routes to an Express
// router; HttpProvider mounts that router at the controller's path. Handlers only read the
// request, call one service or action, and write the response; checks every route shares are
// middleware (http/middleware/).

export class Controller {
    /** Adds this controller's routes to `router`. */
    routes(router) {}

    /** A new Express router with this controller's routes. */
    router() {
        const router = express.Router();
        this.routes(router);
        return router;
    }
}
