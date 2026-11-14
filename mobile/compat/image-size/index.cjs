'use strict';

const fs = require('node:fs');
const { imageSize } = require('image-size-upstream');

// Metro 0.83 uses only synchronous Buffer/path calls. Preserve its former
// 512 KiB header-read bound; every format is parsed by the patched upstream.
function imageSizeForMetro(input) {
  if (typeof input !== 'string') return imageSize(input);
  const descriptor = fs.openSync(input, 'r');
  try {
    const length = Math.min(fs.fstatSync(descriptor).size, 512 * 1024);
    if (length === 0) throw new Error('Empty file');
    const header = Buffer.alloc(length);
    const count = fs.readSync(descriptor, header, 0, length, 0);
    return imageSize(header.subarray(0, count));
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = imageSizeForMetro;
