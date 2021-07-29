const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class RecordingStatusRequestMessage2x extends OutMessage2x {
  constructor (meetingId, userId) {
    super(
      Constants.RECORDING_STATUS_REQUEST_MESSAGE_2x,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId }
    );

    this.core.body = {};
    this.core.body[Constants.REQUESTED_BY] = userId;
  };
}
