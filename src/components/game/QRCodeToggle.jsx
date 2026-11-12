import React, { useState } from 'react';
import { QrCode } from 'lucide-react';
import QRCodeDialog from './QRCodeDialog';

export default function QRCodeToggle({ roomCode }) {
    const [showQRDialog, setShowQRDialog] = useState(false);

    return (
        <>
            <button
                onClick={() => setShowQRDialog(true)}
                className="h-10 w-10 rounded-full bg-white hover:bg-slate-100 transition-colors border flex items-center justify-center"
                aria-label="Show QR Code"
                title="Show QR Code"
            >
                <QrCode className="w-5 h-5 text-slate-600" />
            </button>
            <QRCodeDialog 
                open={showQRDialog} 
                onOpenChange={setShowQRDialog}
                roomCode={roomCode}
            />
        </>
    );
}