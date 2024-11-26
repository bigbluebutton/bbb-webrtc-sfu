const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class UserBroadcastCamStartMsg extends OutMessage2x {
  constructor (
    meetingId,
    userId,
    streamId,
    contentType,
    hasAudio,
  ) {
    super(
      Constants.USER_BROADCAST_CAM_START_MSG,
      { sender: 'bbb-webrtc-sfu', meetingId, userId },
      { meetingId, userId },
    );

    this.core.body = {
      [Constants.STREAM_URL]: streamId,
      [Constants.CONTENT_TYPE]: contentType,
      [Constants.HAS_AUDIO]: hasAudio
    };
  }
}
