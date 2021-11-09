const OutMessage2x = require('../OutMessage2x');
const C = require('../Constants.js');

module.exports = class ScreenshareRTMPBroadcastStartedEventMessage2x extends OutMessage2x {
  constructor (
    conferenceName, screenshareConf, streamUrl, vw, vh, timestamp, hasAudio
  ) {
    super(
      C.SCREENSHARE_RTMP_BROADCAST_STARTED_2x,
      // Another "uncut gem"
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
    // Ensure backwards compatibility
    if (typeof hasAudio !== 'undefined') {
      this.core.body[C.HAS_AUDIO] = hasAudio;
    }
  }
}
