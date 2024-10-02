const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class UserJoinedVoiceConfEvtMsg extends OutMessage2x {
  constructor (
    voiceConf,
    voiceUserId,
    intId,
    callerIdName,
    callerIdNum,
    muted,
    talking,
    callingWith,
    hold,
    uuid,
  ) {
    super(
      Constants.USER_JOINED_VOICE_CONF_EVT_MSG,
      { voiceConf: voiceConf },
      { voiceConf: voiceConf }
    );

    this.core.body = {
      [Constants.VOICE_CONF_2x]: voiceConf,
      [Constants.VOICE_USER_ID]: voiceUserId,
      [Constants.INT_ID]: intId,
      [Constants.CALLER_ID_NAME]: callerIdName,
      [Constants.CALLER_ID_NUM]: callerIdNum,
      [Constants.MUTED]: muted,
      [Constants.TALKING]: talking,
      [Constants.CALLING_WITH]: callingWith,
      [Constants.HOLD]: hold,
      [Constants.UUID]: uuid,
    };
  }
}
