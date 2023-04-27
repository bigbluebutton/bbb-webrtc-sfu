// case class HoldUserInVoiceConfSysMsgBody(voiceConf: String, voiceUserId: String, hold: Boolean)
const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class Hold extends OutMessage2x {
  constructor (meetingId, voiceConf, voiceUserId, hold) {
    super(
      Constants.HOLD,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId }
    );

    this.core.body = {
      [Constants.VOICE_CONF_2x]: voiceConf,
      voiceUserId,
      hold,
    };
  }
}
