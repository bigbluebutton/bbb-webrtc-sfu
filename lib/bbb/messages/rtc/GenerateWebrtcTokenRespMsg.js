const OutMessage2x = require('../OutMessage2x');

const GENERATE_WEBRTC_TOKEN_RESP_MSG = "GenerateWebrtcTokenRespMsg";

module.exports = class GenerateWebrtcTokenRespMsg extends OutMessage2x {
  constructor (meetingId, userId, token, grant) {
    super(
      GENERATE_WEBRTC_TOKEN_RESP_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId },
    );

    this.core.body = {
      token,
      grant,
    }
  }
}
