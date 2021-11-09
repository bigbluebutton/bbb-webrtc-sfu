const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class GetGlobalAudioPermissionReqMsg extends OutMessage2x {
  constructor (meetingId, voiceConf, userId, sfuSessionId) {
    super(
      Constants.GET_GLOBAL_AUDIO_PERM_REQ_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId }
    );

    this.core.body = {};
    this.core.body[Constants.MEETING_ID_2x] = meetingId;
    this.core.body[Constants.VOICE_CONF_2x] = voiceConf;
    this.core.body[Constants.USER_ID_2x] = userId;
    this.core.body[Constants.SFU_SESSION_ID] = sfuSessionId;
  }
}
