import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { roomPath } from '@/lib/roomUrl';

/**
 * Rooms used to live at /GameRoom?code=X. Links and QR codes shared before the move
 * still work: they are redirected to /room/X, or home when they carry no code.
 */
export default function LegacyRoomRedirect() {
    const location = useLocation();
    const code = new URLSearchParams(location.search).get('code');

    if (!code) {
        return <Navigate to="/" replace />;
    }
    return <Navigate to={roomPath(code)} replace />;
}
