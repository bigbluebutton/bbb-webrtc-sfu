const C = require('../../constants/constants');

const getMappedTransportType = (mcsCoreType) => {
  switch (mcsCoreType) {
    case C.MEDIA_TYPE.WEBRTC:
      return 'WebRtcTransport';
    case C.MEDIA_TYPE.RTP:
      return 'PlainTransport';
    default:
      return 'UnknownTransport';
  }
}

module.exports = {
  getMappedTransportType,
}
