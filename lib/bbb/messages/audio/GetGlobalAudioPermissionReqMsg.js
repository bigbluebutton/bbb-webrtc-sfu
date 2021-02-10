var inherits = require('inherits');
var OutMessage2x = require('../OutMessage2x');

module.exports = function (C) {
  function GetGlobalAudioPermissionReqMsg (meetingId, voiceConf, userId, sfuSessionId) {
    GetGlobalAudioPermissionReqMsg.super_.call(this, C.GET_GLOBAL_AUDIO_PERM_REQ_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId }
    );

    this.core.body = {};
    this.core.body[C.MEETING_ID_2x] = meetingId;
    this.core.body[C.VOICE_CONF_2x] = voiceConf;
    this.core.body[C.USER_ID_2x] = userId;
    this.core.body[C.SFU_SESSION_ID] = sfuSessionId;
  };

  inherits(GetGlobalAudioPermissionReqMsg, OutMessage2x);
  return GetGlobalAudioPermissionReqMsg;
}
