/**
 * dsh-skill-menu — host half.
 *
 * Everything this plugin does lives in the browser half (lib/client.js): the
 * '/' trigger source and the `skill` tool conversation row. The host entry
 * exists only because a bundle's main must resolve; it mounts nothing.
 *
 * @module dsh-skill-menu
 */

export const name = 'dsh-skill-menu'

export function apply() {
  /* no host-side behavior */
}
