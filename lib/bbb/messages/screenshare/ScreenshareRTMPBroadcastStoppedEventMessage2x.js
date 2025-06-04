'use strict';

const config = require('config');
const OutMessage2x = require('../OutMessage2x');
const C = require('../Constants.js');

const SCREENSHARE_RPC_ADD_USERID = config.has('screenshareRpcAddUserId')
  ? config.get('screenshareRpcAddUserId')
  : true;

module.exports = class ScreenshareRTMPBroadcastStoppedEventMessage2x extends OutMessage2x {
  constructor (
    conferenceName, screenshareConf, streamUrl, vw, vh, timestamp, options = {},
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
    // Ensure backwards compatibility
    if (typeof options?.userId !== 'undefined' && SCREENSHARE_RPC_ADD_USERID) {
      this.core.body[C.USER_ID_2x] = options?.userId;
    }
  }
}
