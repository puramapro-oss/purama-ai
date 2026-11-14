'use strict';

// query-string 7 requires a callable CommonJS export. Keep decoding entirely
// in the pinned, patched upstream implementation, including its errors.
module.exports = require('decode-uri-component-upstream').default;
