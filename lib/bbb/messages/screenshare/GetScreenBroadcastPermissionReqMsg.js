const inherits = require('inherits');
const OutMessage2x = require('../OutMessage2x');

module.exports = function (C) {
  function GetScreenBroadcastPermissionReqMsg (meetingId, voiceConf, userId, sfuSessionId) {
    GetScreenBroadcastPermissionReqMsg.super_.call(this, C.GET_SCREEN_BROADCAST_PERM_REQ_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId }
    );

    this.core.body = {};
    this.core.body[C.MEETING_ID_2x] = meetingId;
    this.core.body[C.VOICE_CONF_2x] = voiceConf;
    this.core.body[C.USER_ID_2x] = userId;
    this.core.body[C.SFU_SESSION_ID] = sfuSessionId;
  };

  inherits(GetScreenBroadcastPermissionReqMsg, OutMessage2x);
  return GetScreenBroadcastPermissionReqMsg;
}
