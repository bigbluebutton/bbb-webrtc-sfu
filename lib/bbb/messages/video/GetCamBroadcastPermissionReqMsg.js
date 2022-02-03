const OutMessage2x = require('../OutMessage2x');
const C = require('../Constants.js');

module.exports = class GetCamBroadcastPermissionReqMsg extends OutMessage2x {
  constructor (meetingId, userId, streamId, sfuSessionId) {
    super(
      C.GET_CAM_BROADCAST_PERM_REQ_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId }
    );

    this.core.body = {};
    this.core.body[C.MEETING_ID_2x] = meetingId;
    this.core.body[C.USER_ID_2x] = userId;
    this.core.body[C.STREAM_ID] = streamId;
    this.core.body[C.SFU_SESSION_ID] = sfuSessionId;
  }
}
