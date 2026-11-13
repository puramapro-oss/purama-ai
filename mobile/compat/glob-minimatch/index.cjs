'use strict';

const upstream = require('minimatch-upstream');

// Scoped to the constructor used by Glob and Expo Fingerprint. The upstream
// functional helpers remain unchanged; this is not a replacement npm audit.
class Minimatch extends upstream.Minimatch {
  firstPhasePreProcess(rows) {
    const limit = this.options.braceExpandMax ?? 100_000;
    let addedCells = 0;
    // Bound the original algorithm without copying its implementation. A push
    // has already allocated one temporary row; it is rejected before retention
    // or further expansion. The proxy never leaves this preprocessing call.
    const boundedRows = new Proxy(rows, {
      set(target, property, value) {
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property) && Number(property) >= target.length) {
          if (target.length >= limit || addedCells + value.length > 1_000_000) {
            throw new RangeError("optimizationLevel 2: too many patterns from '**/..'");
          }
          addedCells += value.length;
        }
        return Reflect.set(target, property, value);
      },
    });
    super.firstPhasePreProcess(boundedRows);
    return rows;
  }

  secondPhasePreProcess(rows) {
    // This pass only removes redundant alternatives. Keeping the alternatives
    // preserves matching while avoiding its quadratic pairwise comparisons.
    // Upstream first applied the same cutoff in 77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8.
    return rows.length > 1000 ? rows : super.secondPhasePreProcess(rows);
  }
}

module.exports = { ...upstream, Minimatch };
