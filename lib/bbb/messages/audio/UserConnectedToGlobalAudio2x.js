const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class UserConnectedToGlobalAudio2x extends OutMessage2x {
  constructor(voiceConf, userId, name) {
    super(
      Constants.GLOBAL_AUDIO_CONNECTED_2x,
      // Great messaging here, superb RPCs. Just pristine. Clean.
      { voiceConf },
      { voiceConf }
    );

    this.core.body = {};
    this.core.body[Constants.USER_ID_2x] = userId;
    this.core.body[Constants.NAME] = name;
  };
}
