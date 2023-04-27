const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

const LISTEN_ONLY_MODE_TOGGLED_EVT_MSG = "ListenOnlyModeToggledInSfuEvtMsg";

module.exports = class ListenOnlyModeToggledEvtMsg extends OutMessage2x {
  constructor (meetingId, voiceConf, userId, enabled) {
    super(
      LISTEN_ONLY_MODE_TOGGLED_EVT_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { voiceConf }
    );

    this.core.body = {
      [Constants.MEETING_ID_2x]: meetingId,
      [Constants.VOICE_CONF_2x]: voiceConf,
      [Constants.USER_ID_2x]: userId,
      [Constants.ENABLED]: enabled,
    }
  }
}
