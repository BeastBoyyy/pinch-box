// Effect registry, in the order boxes are assigned (each lock takes the next one; keys 1-9 and 0 pick the next one; override with ?order=3,1,2…)
import blobtrack from './blobtrack.js';
import thermal from './thermal.js';
import nightvision from './nightvision.js';
import flashlight from './flashlight.js';
import crt from './crt.js';
import dither from './dither.js';
import pinkphosphor from './pinkphosphor.js';
import halftone from './halftone.js';
import renaissance from './renaissance.js';
import comichero from './comichero.js';

export const ALL = [blobtrack, thermal, nightvision, flashlight, crt, dither, pinkphosphor, halftone, renaissance, comichero];

/** order: array of 1-based indices into ALL (e.g. [9,2,5]) or null for the default */
export function ordered(order) {
  if (!order || !order.length) return ALL;
  const seen = order.filter(i => i >= 1 && i <= ALL.length).map(i => ALL[i - 1]);
  return seen.length ? seen : ALL;
}
