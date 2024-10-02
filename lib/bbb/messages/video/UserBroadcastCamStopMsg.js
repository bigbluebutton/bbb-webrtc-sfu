const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class UserBroadcastCamStopMsg extends OutMessage2x {
  constructor (
    meetingId,
    userId,
    streamId,
  ) {
    super(
      Constants.USER_BROADCAST_CAM_STOP_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId },
    );

    this.core.body = {
      [Constants.STREAM_URL]: streamId,
    };
  }
}
