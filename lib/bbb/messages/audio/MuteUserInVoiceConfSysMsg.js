const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class MuteUserInVoiceConfSysMsg extends OutMessage2x {
  constructor(meetingId, voiceConf, voiceUserId, mute, intId) {
    super(
      Constants.MUTE_USER_IN_VOICE_CONF_SYS_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId }
    );
    this.core.body = {};
    this.core.body[Constants.VOICE_CONF_2x] = voiceConf;
    this.core.body[Constants.VOICE_USER_ID] = voiceUserId;
    this.core.body[Constants.MUTE] = mute;
    this.core.body[Constants.INT_ID] = intId;
  }
}
