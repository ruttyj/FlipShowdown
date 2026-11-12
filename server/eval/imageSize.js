// Reads a photo's width and height from its header, without decoding it or adding a dependency. Only
// the eval script needs this, to refuse a photo the app could never send (scanEval.js).

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- JPEG ------------------------------------------------------------------

const JPEG_START = 0xd8;
const JPEG_START_OF_SCAN = 0xda;

/** The frame header markers: 0xC0 to 0xCF, less three that share the range and hold other things. */
function isJpegFrameMarker(marker) {
    const isInRange = marker >= 0xc0 && marker <= 0xcf;
    const isOtherSegment = marker === 0xc4 || marker === 0xc8 || marker === 0xcc;
    return isInRange && !isOtherSegment;
}

/** Walks the segments to the frame header. Each one is a marker and then its own 2-byte length. */
function readJpegSize(bytes) {
    const isJpeg = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === JPEG_START;
    if (!isJpeg) {
        return null;
    }

    let offset = 2;
    while (offset + 9 <= bytes.length) {
        if (bytes[offset] !== 0xff) {
            return null;
        }

        const marker = bytes[offset + 1];
        if (isJpegFrameMarker(marker)) {
            return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
        }
        if (marker === JPEG_START_OF_SCAN) {
            return null;
        }
        offset += 2 + bytes.readUInt16BE(offset + 2);
    }
    return null;
}

// --- PNG -------------------------------------------------------------------

function readPngSize(bytes) {
    const isPng = bytes.length >= 24
        && bytes.subarray(0, 8).equals(PNG_SIGNATURE)
        && bytes.toString('latin1', 12, 16) === 'IHDR';
    if (!isPng) {
        return null;
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// --- WebP ------------------------------------------------------------------

/** Lossy: 14-bit sizes after a 3-byte frame tag and a 3-byte start code; the top 2 bits are scaling. */
function readWebpLossySize(bytes) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
}

/** Lossless: after a signature byte, 14 bits each for width - 1 and height - 1. */
function readWebpLosslessSize(bytes) {
    const packed = bytes.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
}

/** Extended: after 4 bytes of flags and padding, 24 bits each for width - 1 and height - 1. */
function readWebpExtendedSize(bytes) {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
}

const WEBP_CHUNKS = new Map([
    ['VP8 ', { headerLength: 30, readSize: readWebpLossySize }],
    ['VP8L', { headerLength: 25, readSize: readWebpLosslessSize }],
    ['VP8X', { headerLength: 30, readSize: readWebpExtendedSize }],
]);

function readWebpSize(bytes) {
    const isWebp = bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';
    if (!isWebp) {
        return null;
    }

    const chunk = WEBP_CHUNKS.get(bytes.toString('latin1', 12, 16));
    if (!chunk || bytes.length < chunk.headerLength) {
        return null;
    }
    return chunk.readSize(bytes);
}

// --- Any format ------------------------------------------------------------

/**
 * The size stored in a photo's header, ignoring any EXIF rotation, which can't change the long edge.
 *
 * @param {Buffer} bytes
 * @param {string} mimeType  from the file's extension, so a file that isn't what its name says is null
 * @returns {{width: number, height: number}|null}  null when the header can't be read
 */
export function readImageSize(bytes, mimeType) {
    if (mimeType === 'image/jpeg') {
        return readJpegSize(bytes);
    }
    if (mimeType === 'image/png') {
        return readPngSize(bytes);
    }
    if (mimeType === 'image/webp') {
        return readWebpSize(bytes);
    }
    return null;
}
