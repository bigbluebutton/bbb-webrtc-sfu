const OutMessage2x = require('../OutMessage2x');
const C = require('../Constants.js');

module.exports = class ScreenshareRTMPBroadcastStoppedEventMessage2x extends OutMessage2x {
  constructor (
    conferenceName, screenshareConf, streamUrl, vw, vh, timestamp
  ) {
    super(
      C.SCREENSHARE_RTMP_BROADCAST_STOPPED_2x,
      { voiceConf: conferenceName },
      { voiceConf: conferenceName }
    );

    this.core.body = {};
    this.core.body[C.CONFERENCE_NAME] = conferenceName;
    this.core.body[C.SCREENSHARE_CONF] = screenshareConf;
    this.core.body[C.STREAM_URL] = streamUrl;
    this.core.body[C.VIDEO_WIDTH] = vw;
    this.core.body[C.VIDEO_HEIGHT] = vh;
    this.core.body[C.TIMESTAMP] = timestamp;
  };
}
