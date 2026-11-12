import QRCode from 'qrcode';
import React, { useEffect, useState } from 'react';

const QR_SIZE_PX = 220;

// White modules on a clear background, like the lobby's QRCodeImage, for the gradient card (X65).
const QR_OPTIONS = {
    type: /** @type {'svg'} */ ('svg'),
    margin: 2,
    errorCorrectionLevel: /** @type {'M'} */ ('M'),
    color: { dark: '#ffffff', light: '#00000000' },
};

/**
 * The tunnel link (or a room's join link on it) as a large QR code. Drawn as SVG, which needs no
 * canvas and stays sharp at any size.
 * @param {{ url: string, alt?: string }} props
 */
export default function TunnelQrCode({ url, alt = 'QR code for the game link' }) {
    const [image, setImage] = useState(/** @type {{ url: string, src: string | null } | null} */ (null));

    useEffect(() => {
        let isCurrent = true;

        QRCode.toString(url, QR_OPTIONS)
            .then((svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
            .catch(() => null)
            .then((src) => {
                if (isCurrent) {
                    setImage({ url, src });
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [url]);

    // Nothing until this URL's code is ready, so a stale code is never shown for a new link.
    if (!image || image.url !== url) {
        return <div style={{ width: QR_SIZE_PX, height: QR_SIZE_PX }} className="rounded-lg bg-white/10" />;
    }
    if (image.src === null) {
        return <p role="alert" className="text-sm text-red-200">Couldn't draw the QR code. Share the link below instead.</p>;
    }

    return (
        <img
            src={image.src}
            alt={alt}
            width={QR_SIZE_PX}
            height={QR_SIZE_PX}
            className="rounded-lg"
        />
    );
}
