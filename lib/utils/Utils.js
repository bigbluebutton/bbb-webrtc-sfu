/**
 *  * @classdesc
 *   * Utils class for bbb-webrtc-sfu
 *    * @constructor
 *     */


/*
 * hrTime
 * Gets monotonic system time in milliseconds
 */

exports.hrTime = function () {
  let t = process.hrtime();

  return t[0]*1000 + parseInt(t[1]/1000000);
}

exports.addBwToSpecMainType = (spec, bitrate) => {
  spec['H264'].as_main = bitrate;
  spec['H264'].tias_main = (bitrate >>> 0) * 1000;
  spec['VP8'].as_main = bitrate;
  spec['VP8'].tias_main = (bitrate >>> 0) * 1000;
  return spec;
}

exports.addBwToSpecContentType = (spec, bitrate) => {
  spec['H264'].as_content = bitrate;
  spec['H264'].tias_content = (bitrate >>> 0) * 1000;
  spec['VP8'].as_content  = bitrate;
  spec['VP8'].tias_content = (bitrate >>> 0) * 1000;
  return spec;
}
