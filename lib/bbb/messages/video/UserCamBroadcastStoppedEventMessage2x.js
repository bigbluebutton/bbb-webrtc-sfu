const OutMessage2x = require('../OutMessage2x');
const C = require('../Constants.js');

module.exports = class UserCamBroadcastStoppedEventMessage2x extends OutMessage2x {
  constructor (meetingId, userId, stream) {
    super(
      C.USER_CAM_BROADCAST_STOPPED_2x,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId }
    );

    this.core.body = {};
    this.core.body[C.STREAM_URL] = stream;
  };
}
