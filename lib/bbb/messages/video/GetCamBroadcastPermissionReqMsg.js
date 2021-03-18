const inherits = require('inherits');
const OutMessage2x = require('../OutMessage2x');

module.exports = function (C) {
  function GetCamBroadcastPermissionReqMsg (meetingId, userId, sfuSessionId) {
    GetCamBroadcastPermissionReqMsg.super_.call(this, C.GET_CAM_BROADCAST_PERM_REQ_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId }
    );

    this.core.body = {};
    this.core.body[C.MEETING_ID_2x] = meetingId;
    this.core.body[C.USER_ID_2x] = userId;
    this.core.body[C.SFU_SESSION_ID] = sfuSessionId;
  };

  inherits(GetCamBroadcastPermissionReqMsg, OutMessage2x);
  return GetCamBroadcastPermissionReqMsg;
}
