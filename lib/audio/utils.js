const config = require('config');

const STRIP_TWCC_EXT = config.has('audioStripTwccExt')
  ? config.get('audioStripTwccExt')
  : true;

// Strip transport-cc from mic/listen only streams for now - FREESWITCH
// doesn't support it and having it enabled on the client side seems to trip
// something up there in regards to RTP packet processing for reasons yet
// unknown - prlanzarin Mar 27 2022
const getAudioRtpHdrExts = () => {
  if (!STRIP_TWCC_EXT) return;

  return config.has('mediasoup.webRtcHeaderExts') ?
    config.util.cloneDeep(config.get('mediasoup.webRtcHeaderExts')).filter(
      ({ uri } ) => uri !== 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'
    ) : undefined;
}

module.exports = {
  getAudioRtpHdrExts,
};
