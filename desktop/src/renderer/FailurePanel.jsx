import React, { useId, useState } from 'react';
import { Button } from '@/components/ui/button';

/** How many of the most recent lines each log shows. */
export const LOG_LINES_SHOWN = 50;

/**
 * The error state: why hosting stopped, Retry, Dismiss (back to idle, which Reset data needs)
 * and the last lines the server and tunnel printed.
 * @param {{ snapshot: import('../shared/launcherBridge').HostingSnapshot,
 *   onRetry: () => void, onDismiss: () => void }} props
 */
export default function FailurePanel({ snapshot, onRetry, onDismiss }) {
    const [showLogs, setShowLogs] = useState(false);
    const logsId = useId();

    return (
        <div className="flex flex-col gap-3">
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <h2 className="mb-1 font-medium">Hosting stopped</h2>
                <p>{snapshot.error ?? 'Something went wrong.'}</p>
            </div>
            <div className="flex gap-2">
                <Button className="launcher-action" onClick={onRetry}>Retry</Button>
                <Button variant="outline" onClick={onDismiss}>Dismiss</Button>
                <Button
                    variant="outline"
                    aria-expanded={showLogs}
                    aria-controls={logsId}
                    onClick={() => setShowLogs(!showLogs)}
                >
                    {showLogs ? 'Hide logs' : 'Show logs'}
                </Button>
            </div>
            {showLogs && (
                <div id={logsId} className="flex flex-col gap-3">
                    <LogOutput title="Server output" lines={snapshot.serverLog} />
                    <LogOutput title="Tunnel output" lines={snapshot.tunnelLog} />
                </div>
            )}
        </div>
    );
}

/** @param {{ title: string, lines: string[] }} props */
function LogOutput({ title, lines }) {
    const titleId = useId();
    let text = 'No output.';
    if (lines.length > 0) {
        text = lines.slice(-LOG_LINES_SHOWN).join('\n');
    }

    return (
        <section>
            <h3 id={titleId} className="mb-1 text-sm font-medium">{title}</h3>
            <pre
                aria-labelledby={titleId}
                tabIndex={0}
                className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs"
            >
                {text}
            </pre>
        </section>
    );
}
