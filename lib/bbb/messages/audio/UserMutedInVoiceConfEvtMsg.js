const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class UserMutedInVoiceConfEvtMsg extends OutMessage2x {
  constructor (
    voiceConf,
    voiceUserId,
    muted,
  ) {
    super(
      Constants.USER_MUTED_IN_VOICE_CONF_EVT_MSG,
      { voiceConf: voiceConf },
      { voiceConf: voiceConf }
    );

    this.core.body = {
      [Constants.VOICE_CONF_2x]: voiceConf,
      [Constants.VOICE_USER_ID]: voiceUserId,
      [Constants.MUTED]: muted,
    };
  }
}
