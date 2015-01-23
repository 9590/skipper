/**
 * Module dependencies
 */

var _ = require('lodash');



module.exports = function(options) {

  // Apply defaults
  options = options || {};
  _.defaults(options, {

    // maxWaitTime is the maximum # of ms to wait for the first file
    maxTimeToWaitForFirstFile: 500,

    // maxBufferTime is the maximum # of ms to wait for an UploadStream
    // to be plugged in to something (i.e. buffering the incoming bytes)
    // before dropping it.
    // (this can probably be replaced with `highWaterMark` and `lowWaterMark`
    // in streams2)
    maxTimeToBuffer: 2500

  });

  return options;
};
