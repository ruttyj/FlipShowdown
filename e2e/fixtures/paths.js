// Absolute paths shared by the e2e fixtures, so they work from any working directory.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SRC_DIR = path.join(REPO_ROOT, 'src');
export const SHARED_DIR = path.join(REPO_ROOT, 'shared');
export const DIST_DIR = path.join(REPO_ROOT, 'dist');
export const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'src', 'index.js');
