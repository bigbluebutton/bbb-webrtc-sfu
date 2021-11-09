const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class UserDisconnectedFromGlobalAudio2x extends OutMessage2x {
  constructor (voiceConf, userId, name) {
    super(
      Constants.GLOBAL_AUDIO_DISCONNECTED_2x,
      // *chef's kiss*
      { voiceConf: voiceConf },
      { voiceConf: voiceConf }
    );

    this.core.body = {};
    this.core.body[Constants.USER_ID_2x] = userId;
    this.core.body[Constants.NAME] = name;
  }
};
