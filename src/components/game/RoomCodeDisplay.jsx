import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Hash, Link, Check, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import QRCodeImage from '@/components/QRCodeImage';
import { roomPath } from '@/lib/roomUrl';

function IconButton({ label, onClick, children }) {
    return (
        <Button
            variant="outline"
            size="icon"
            onClick={onClick}
            aria-label={label}
            title={label}
            className="bg-white/10 border-white/20 text-white hover:bg-white/20 hover:text-white"
        >
            {children}
        </Button>
    );
}

/** The room code, its QR code and compact copy/share buttons. `children` render above the buttons (the host's Start Game). */
export default function RoomCodeDisplay({ roomCode, children }) {
    const [copiedCode, setCopiedCode] = useState(false);
    const [copiedLink, setCopiedLink] = useState(false);

    const copyCode = () => {
        navigator.clipboard.writeText(roomCode);
        setCopiedCode(true);
        toast.success('Room code copied!');
        setTimeout(() => setCopiedCode(false), 2000);
    };

    const copyLink = () => {
        const link = `${window.location.origin}${roomPath(roomCode)}`;
        navigator.clipboard.writeText(link);
        setCopiedLink(true);
        toast.success('Room link copied!');
        setTimeout(() => setCopiedLink(false), 2000);
    };

    const shareLink = async () => {
        const link = `${window.location.origin}${roomPath(roomCode)}`;
        const shareData = {
            title: 'Join my Flip Showdown room',
            text: `Join my game on Flip Showdown! Room code: ${roomCode}`,
            url: link
        };

        if (navigator.share) {
            try {
                await navigator.share(shareData);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    toast.error('Failed to share');
                }
            }
        } else {
            copyLink();
        }
    };

    return (
        <>
            <div className="room-code-card rounded-2xl p-6 text-center">
                <p className="text-white/80 text-sm uppercase tracking-wider mb-2">Room Code</p>
                <div className="text-4xl font-mono font-bold text-white tracking-[0.3em] mb-4">
                    {roomCode}
                </div>
                <QRCodeImage
                    url={`${window.location.origin}${roomPath(roomCode)}`}
                    alt={`QR code to join room ${roomCode}`}
                    className="mb-6"
                />
                {children}
                <div className="flex gap-2 justify-center">
                    <IconButton label="Copy room code" onClick={copyCode}>
                        {copiedCode ? <Check className="w-5 h-5" /> : <Hash className="w-5 h-5" />}
                    </IconButton>
                    <IconButton label="Copy join link" onClick={copyLink}>
                        {copiedLink ? <Check className="w-5 h-5" /> : <Link className="w-5 h-5" />}
                    </IconButton>
                    <IconButton label="Share join link" onClick={shareLink}>
                        <Share2 className="w-5 h-5" />
                    </IconButton>
                </div>
            </div>
        </>
    );
}