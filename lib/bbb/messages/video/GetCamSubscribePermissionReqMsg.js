const inherits = require('inherits');
const OutMessage2x = require('../OutMessage2x');

module.exports = function (C) {
  function GetCamSubscribePermissionReqMsg (meetingId, userId, streamId, sfuSessionId) {
    GetCamSubscribePermissionReqMsg.super_.call(this, C.GET_CAM_SUBSCRIBE_PERM_REQ_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId }
    );

    this.core.body = {};
    this.core.body[C.MEETING_ID_2x] = meetingId;
    this.core.body[C.USER_ID_2x] = userId;
    this.core.body[C.STREAM_ID] = streamId;
    this.core.body[C.SFU_SESSION_ID] = sfuSessionId;
  };

  inherits(GetCamSubscribePermissionReqMsg, OutMessage2x);
  return GetCamSubscribePermissionReqMsg;
}
