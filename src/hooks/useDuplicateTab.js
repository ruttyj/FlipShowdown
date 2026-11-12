import { useEffect, useState } from 'react';
import {
    DUPLICATE_TAB_CHANNEL,
    byeMessage,
    handleTabMessage,
    helloMessage,
    updateOtherTabs,
} from '@/lib/duplicateTab';

// True while the same room is open in another tab of this browser.
export function useDuplicateTab(roomId) {
    const [otherTabIds, setOtherTabIds] = useState([]);

    useEffect(() => {
        if (!roomId || typeof BroadcastChannel === 'undefined') {
            return undefined;
        }
        const tabId = Math.random().toString(36).slice(2);
        const channel = new BroadcastChannel(DUPLICATE_TAB_CHANNEL);
        setOtherTabIds([]);

        channel.onmessage = (event) => {
            setOtherTabIds((current) => updateOtherTabs(current, event.data, roomId, tabId));
            const { reply } = handleTabMessage(event.data, roomId, tabId);
            if (reply) {
                channel.postMessage(reply);
            }
        };
        channel.postMessage(helloMessage(roomId, tabId));

        // pagehide covers closing the tab; a page restored from the back/forward cache says
        // hello again on pageshow.
        const sayBye = () => {
            channel.postMessage(byeMessage(roomId, tabId));
        };
        const sayHello = (event) => {
            if (event.persisted) {
                channel.postMessage(helloMessage(roomId, tabId));
            }
        };
        window.addEventListener('pagehide', sayBye);
        window.addEventListener('pageshow', sayHello);

        return () => {
            window.removeEventListener('pagehide', sayBye);
            window.removeEventListener('pageshow', sayHello);
            sayBye();
            channel.close();
        };
    }, [roomId]);

    return otherTabIds.length > 0;
}
