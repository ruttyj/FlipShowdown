import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { QrCode, RotateCcw, Copy, Check } from 'lucide-react';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { roomPath } from '@/lib/roomUrl';

export default function QRCodeDialog({ open, onOpenChange, roomCode }) {
    const [qrDataUrl, setQrDataUrl] = useState(null);
    const [hasError, setHasError] = useState(false);
    const [isRendering, setIsRendering] = useState(false);
    const [copiedUrl, setCopiedUrl] = useState(false);
    const [copiedCode, setCopiedCode] = useState(false);

    const joinLink = `${window.location.origin}${roomPath(roomCode)}`;

    const copyToClipboard = (text, type) => {
        navigator.clipboard.writeText(text).then(() => {
            if (type === 'url') {
                setCopiedUrl(true);
                setTimeout(() => setCopiedUrl(false), 2000);
            } else {
                setCopiedCode(true);
                setTimeout(() => setCopiedCode(false), 2000);
            }
            toast.success('Copied to clipboard!');
        });
    };

    // Render to a data URL rather than drawing on a canvas ref: the dialog content mounts in a
    // portal with an open animation, so a canvas isn't reliably there when the effect runs.
    const generateQR = () => {
        if (!roomCode) {
            return;
        }

        setIsRendering(true);
        setHasError(false);
        QRCode.toDataURL(joinLink, {
            width: 280,
            margin: 2,
            // White modules on a transparent background; the panel behind it supplies the contrast.
            color: {
                dark: '#ffffff',
                light: '#00000000',
            },
            errorCorrectionLevel: 'H',
        })
            .then(setQrDataUrl)
            .catch((error) => {
                console.error('[QR Code] Generation error:', error);
                setHasError(true);
            })
            .finally(() => setIsRendering(false));
    };

    useEffect(() => {
        if (open) {
            generateQR();
        }
    }, [open, roomCode]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm p-6">
                <DialogTitle className="text-center flex items-center justify-center gap-2 mb-2">
                    <QrCode className="w-5 h-5 text-ui-accent" />
                    <span>Game Room QR Code</span>
                </DialogTitle>
                <div className="text-center">
                    <p className="text-sm text-slate-700 mb-4">
                        Scan this QR code to join the room
                    </p>
                    <div className="bg-slate-900 p-4 rounded-lg border border-slate-700 flex justify-center items-center min-h-[300px]">
                        {qrDataUrl && (
                            <img
                                src={qrDataUrl}
                                alt={`QR code to join room ${roomCode}`}
                                width={280}
                                height={280}
                                className="block"
                            />
                        )}
                        {hasError && (
                            <p className="text-sm text-red-600">Couldn't generate the QR code.</p>
                        )}
                    </div>
                    {isRendering && (
                        <p className="text-xs text-slate-500 mt-3">Generating QR code...</p>
                    )}
                    <Button
                        onClick={generateQR}
                        disabled={isRendering}
                        variant="outline"
                        size="sm"
                        className="mt-4"
                    >
                        <RotateCcw className="w-4 h-4 mr-2" />
                        Regenerate
                    </Button>
                    <div className="mt-4 space-y-2">
                        <button
                            onClick={() => copyToClipboard(joinLink, 'url')}
                            className="w-full text-left p-2 rounded-lg hover:bg-slate-50 transition-colors group"
                        >
                            <p className="text-xs text-slate-600">
                                <span className="font-mono text-slate-900 break-all group-hover:text-ui-accent flex items-center gap-2">
                                    {joinLink}
                                    {copiedUrl ? (
                                        <Check className="w-3 h-3 text-green-500" />
                                    ) : (
                                        <Copy className="w-3 h-3 text-slate-400 opacity-0 group-hover:opacity-100" />
                                    )}
                                </span>
                            </p>
                        </button>
                        <button
                            onClick={() => copyToClipboard(roomCode, 'code')}
                            className="w-full text-left p-2 rounded-lg hover:bg-slate-50 transition-colors group"
                        >
                            <p className="text-xs text-slate-600">
                                Room Code: <span className="font-mono font-bold text-slate-900 group-hover:text-ui-accent flex items-center gap-2 inline-flex">{roomCode}
                                    {copiedCode ? (
                                        <Check className="w-3 h-3 text-green-500" />
                                    ) : (
                                        <Copy className="w-3 h-3 text-slate-400 opacity-0 group-hover:opacity-100" />
                                    )}
                                </span>
                            </p>
                        </button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
