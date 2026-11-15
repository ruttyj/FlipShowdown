import express from 'express';
import { requireObjectBody } from '../middleware/jsonBody.js';
import { Controller } from './Controller.js';

// /api/ai: whether card scanning is on and which models it offers, and the scan itself. Mounted
// behind requireUser, so req.user is set, and before the global /api JSON parser, which would
// reject photo uploads with its smaller body limit.

// MAX_IMAGE_BYTES (services/ai/ScanService.js) as base64, plus the JSON wrapper.
const SCAN_BODY_LIMIT = '6mb';

const scanBody = requireObjectBody({ message: 'Body must be a JSON object with an image data URL' });

function sendError(res, status, message) {
    res.status(status).json({ message });
}

export class AiController extends Controller {
    /** `scans` is the ScanService. */
    constructor({ scans }) {
        super();
        this.scans = scans;
    }

    routes(router) {
        router.get('/config', (req, res) => this.getConfig(req, res));
        router.post(
            '/scan-cards',
            (req, res, next) => this.requireEnabled(req, res, next),
            // Rate-limit before parsing so a flood of large uploads isn't even read.
            (req, res, next) => this.limitScanRate(req, res, next),
            express.json({ limit: SCAN_BODY_LIMIT }),
            scanBody,
            (req, res) => this.scanCards(req, res),
        );
    }

    async getConfig(req, res) {
        res.json(await this.scans.getConfig());
    }

    requireEnabled(req, res, next) {
        if (!this.scans.isEnabled()) {
            sendError(res, 503, 'AI card scanning is not set up on this server');
            return;
        }
        next();
    }

    limitScanRate(req, res, next) {
        if (!this.scans.tryStartScan(req.user.email)) {
            sendError(res, 429, 'Too many scans. Wait a minute and try again.');
            return;
        }
        next();
    }

    async scanCards(req, res) {
        const result = await this.scans.scan(req.body);
        res.status(result.status).json(result.body);
    }
}
