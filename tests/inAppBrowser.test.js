import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInAppBrowser } from '../src/lib/inAppBrowser.js';

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

test('normal mobile browsers are not in-app browsers', () => {
    assert.equal(isInAppBrowser(SAFARI), false);
    assert.equal(isInAppBrowser(CHROME_ANDROID), false);
});

test('Facebook, Instagram and Android WebViews are in-app browsers', () => {
    assert.equal(isInAppBrowser(`${SAFARI} [FBAN/FBIOS;FBAV/470.0.0]`), true);
    assert.equal(isInAppBrowser(`${SAFARI} Instagram 340.0.0`), true);
    const webView = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36';
    assert.equal(isInAppBrowser(webView), true);
});

test('a missing user agent is not an in-app browser', () => {
    assert.equal(isInAppBrowser(undefined), false);
    assert.equal(isInAppBrowser(''), false);
});
