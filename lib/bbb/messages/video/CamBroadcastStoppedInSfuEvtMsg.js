const OutMessage2x = require('../OutMessage2x');
const C = require('../Constants.js');

const CAM_BROADCAST_STOPPED_IN_SFU_EVT_MSG = 'CamBroadcastStoppedInSfuEvtMsg';

module.exports = class CamBroadcastStoppedInSfuEvtMsg extends OutMessage2x {
  constructor (meetingId, userId, streamId) {
    super(
      CAM_BROADCAST_STOPPED_IN_SFU_EVT_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId }
    );

    this.core.body = {
      [C.STREAM_ID]: streamId,
    }
  }
}
