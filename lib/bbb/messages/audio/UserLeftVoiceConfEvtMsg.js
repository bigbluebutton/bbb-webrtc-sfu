const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class UserLeftVoiceConfEvtMsg extends OutMessage2x {
  constructor (
    voiceConf,
    voiceUserId,
  ) {
    super(
      Constants.USER_LEFT_VOICE_CONF_EVT_MSG,
      { voiceConf: voiceConf },
      { voiceConf: voiceConf }
    );

    this.core.body = {
      [Constants.VOICE_CONF_2x]: voiceConf,
      [Constants.VOICE_USER_ID]: voiceUserId,
    };
  }
}
