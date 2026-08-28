/* global globalThis */

/**
 * @fileoverview UID generator, from Blockly.
 */

/**
 * Legal characters for the unique ID.
 * Should be all on a US keyboard.  No XML special characters or control codes.
 * Removed $ due to issue 251.
 * @private
 */
const soup_ = '!#%()*+,-./:;=?@[]^_`{|}~' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * The cryptographically strong random source, resolved once at module load.
 * globalThis.crypto is available in all modern browsers and in Node >= 17.4.
 * When unavailable, uid falls back to the Math.random implementation below.
 */
const cryptoObject = (typeof globalThis !== 'undefined' && globalThis.crypto &&
    typeof globalThis.crypto.getRandomValues === 'function') ? globalThis.crypto : null;

/**
 * Generate a unique ID, from Blockly.  This should be globally unique.
 * 87 characters ^ 20 length > 128 bits (better than a UUID).
 * @return {string} A globally unique ID string.
 */
const uid = function () {
    // Use the cryptographically strong source when available.
    if (cryptoObject) {
        const bytes = new Uint8Array(20);
        cryptoObject.getRandomValues(bytes);
        return Array.from(bytes, b => soup_.charAt(b % soup_.length)).join('');
    }
    // Fallback to the original Math.random-based implementation.
    const length = 20;
    const soupLength = soup_.length;
    const id = [];
    for (let i = 0; i < length; i++) {
        id[i] = soup_.charAt(Math.random() * soupLength);
    }
    return id.join('');
};

module.exports = uid;
