import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * White QR modules on a transparent background, for placing on dark panels.
 * Renders nothing until the image is ready (or if generation fails).
 */
export default function QRCodeImage({ url, size = 260, alt, className = '' }) {
    const [dataUrl, setDataUrl] = useState(null);

    useEffect(() => {
        if (!url) {
            return;
        }

        QRCode.toDataURL(url, {
            width: size,
            margin: 1,
            color: {
                dark: '#ffffff',
                light: '#00000000',
            },
            errorCorrectionLevel: 'H',
        })
            .then(setDataUrl)
            .catch((error) => console.error('[QR Code] Generation error:', error));
    }, [url, size]);

    if (!dataUrl) {
        return null;
    }

    return (
        <img
            src={dataUrl}
            alt={alt}
            width={size}
            height={size}
            className={`block mx-auto max-w-full h-auto ${className}`}
        />
    );
}
