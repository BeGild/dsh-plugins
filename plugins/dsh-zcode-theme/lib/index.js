/**
 * dsh-zcode-theme — host half.
 *
 * The theme lives entirely in the browser (lib/client.js). This module exists
 * because a bundle row needs a resolvable plugin, and because the client module
 * system discovers `dsh.client` packages from the host loader's entries — a
 * package that is not a Cordis row is never scanned.
 *
 * It registers nothing and touches nothing on the host.
 */

export const name = 'dsh-zcode-theme'

/** @param {import('@deepseek-ai/cordis').Context} _ctx */
export function apply(_ctx) {}
