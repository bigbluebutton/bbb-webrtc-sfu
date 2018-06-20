/*
 * 
 */

var inherits = require('inherits');
var OutMessage2x = require('../OutMessage2x');

module.exports = function (C) {
  function ScreenshareRTMPBroadcastStoppedEventMessage2x (conferenceName, screenshareConf,
      streamUrl, vw, vh, timestamp) {
    ScreenshareRTMPBroadcastStoppedEventMessage2x.super_.call(this, C.SCREENSHARE_RTMP_BROADCAST_STOPPED_2x,
        {voiceConf: conferenceName}, {voiceConf: conferenceName});

    this.core.body = {};
    this.core.body[C.CONFERENCE_NAME_2x] = conferenceName;
    this.core.body[C.SCREENSHARE_CONF_2x] = screenshareConf;
    this.core.body[C.STREAM_URL_2x] = streamUrl;
    this.core.body[C.VIDEO_WIDTH_2x] = vw;
    this.core.body[C.VIDEO_HEIGHT_2x] = vh;
    this.core.body[C.TIMESTAMP_2x] = timestamp;
  };

  inherits(ScreenshareRTMPBroadcastStoppedEventMessage2x, OutMessage2x);
  return ScreenshareRTMPBroadcastStoppedEventMessage2x;
}
