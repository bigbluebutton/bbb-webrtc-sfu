const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class GetMicrophonePermissionReqMsg extends OutMessage2x {
  constructor (meetingId, voiceConf, userId, sfuSessionId) {
    super(
      Constants.GET_MIC_PERM_REQ_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId }
    );

    this.core.body = {
      [Constants.MEETING_ID_2x]: meetingId,
      [Constants.VOICE_CONF_2x]: voiceConf,
      [Constants.USER_ID_2x]: userId,
      [Constants.SFU_SESSION_ID]: sfuSessionId,
    };
  }
}
