const OutMessage2x = require('../OutMessage2x');
const C = require('../Constants.js');

// Death to needlessly centralized constants
const CAM_STREAM_UNSUBSCRIBED_EVT_MSG = 'CamStreamUnsubscribedInSfuEvtMsg';

module.exports = class CamStreamUnsubscribedInSfuEvtMsg extends OutMessage2x {
  constructor (meetingId, userId, streamId, subscriberStreamId, sfuSessionId) {
    super(
      CAM_STREAM_UNSUBSCRIBED_EVT_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId }
    );

    this.core.body = {
      [C.STREAM_ID]: streamId,
      [C.SUBSCRIBER_STREAM_ID]: subscriberStreamId,
      [C.SFU_SESSION_ID]: sfuSessionId,
    };
  }
}
