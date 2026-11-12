import { createServer } from './app.js';
import { loadConfig } from './config.js';

function logStartup(config, port) {
    console.log(`Flip Showdown server listening on port ${port} (AUTH_MODE=${config.authMode})`);
    console.log(`Data: ${config.dataDir}`);
    console.log(`Entities: ${[...config.entities].join(', ')}`);
    if (config.authMode === 'dev' && config.sessionSecretGenerated) {
        console.log(`SESSION_SECRET is not set; using the one saved in ${config.dataDir}`);
    }
    if (config.adminEmailsIgnored) {
        console.warn('ADMIN_EMAILS is ignored in AUTH_MODE=dev: the login page has no password, so anyone '
            + 'could sign in as an admin. Set DEV_ALLOW_ADMINS=true only on a server nobody else can reach.');
    }
}

function installShutdownHandlers(instance) {
    let isShuttingDown = false;

    async function shutdown(signal) {
        if (isShuttingDown) {
            return;
        }
        isShuttingDown = true;

        console.log(`Received ${signal}, shutting down`);
        await instance.close();
        process.exit(0);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

function main() {
    const config = loadConfig();
    const instance = createServer(config);

    instance.server.listen(config.port, () => {
        logStartup(config, instance.server.address().port);
    });
    installShutdownHandlers(instance);
}

main();
