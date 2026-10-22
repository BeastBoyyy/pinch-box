// Effect registry. DEFAULT_ORDER is the order boxes are assigned (each lock takes the next one); override with ?order=3,1,2…
import edge from './edge.js';
import slitscan from './slitscan.js';
import moire from './moire.js';
import pixsort from './pixsort.js';
import frosted from './frosted.js';
import datamosh from './datamosh.js';
import crt from './crt.js';
import depthmap from './depthmap.js';
import pointcloud from './pointcloud.js';
import quadtree from './quadtree.js';
import cyanotype from './cyanotype.js';
import posterize from './posterize.js';

export const ALL = [edge, slitscan, moire, pixsort, frosted, datamosh, crt, depthmap, pointcloud, quadtree, cyanotype, posterize];

/** order: array of 1-based indices into ALL (e.g. [10,11,12,1]) or null for the default */
export function ordered(order) {
  if (!order || !order.length) return ALL;
  const seen = order.filter(i => i >= 1 && i <= ALL.length).map(i => ALL[i - 1]);
  return seen.length ? seen : ALL;
}
