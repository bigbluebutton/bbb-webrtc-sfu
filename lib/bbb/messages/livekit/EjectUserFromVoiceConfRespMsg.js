const OutMessage2x = require('../OutMessage2x');

const EJECT_USER_FROM_VOICE_CONF_RESP_MSG = "EjectUserFromVoiceConfRespMsg";

module.exports = class EjectUserFromVoiceConfRespMsg extends OutMessage2x {
  constructor (meetingId, voiceConf, voiceUserId, outcome) {
    super(
      EJECT_USER_FROM_VOICE_CONF_RESP_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId: voiceUserId },
    );

    this.core.body = {
      voiceConf,
      voiceUserId,
      outcome,
    }
  }
}
