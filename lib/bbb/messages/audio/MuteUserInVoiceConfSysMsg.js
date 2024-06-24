const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class MuteUserInVoiceConfSysMsg extends OutMessage2x {
  constructor(meetingId, voiceConf, voiceUserId, mute) {
    super(
      Constants.MUTE_USER_IN_VOICE_CONF_SYS_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId }
    );
// 2024-06-24 {"envelope":{"name":"MuteUserInVoiceConfSysMsg","routing":{"sender":"bbb-apps-akka"},"timestamp":1719260091385},"core":{"header":{"name":"MuteUserInVoiceConfSysMsg","meetingId":"740b7fbb2a5513ae03080c7498475ecfe24df92d-1719259537950"},"body":{"voiceConf":"77386","voiceUserId":"153","mute":true}}}
    this.core.body = {};
    this.core.body[Constants.VOICE_CONF_2x] = voiceConf;
    this.core.body[Constants.VOICE_USER_ID] = voiceUserId;
    this.core.body[Constants.MUTE] = mute;
  }
}
