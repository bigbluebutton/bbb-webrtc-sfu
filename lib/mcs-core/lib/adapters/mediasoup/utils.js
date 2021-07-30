'use strict';

const SoupRTPU = require("mediasoup-client/lib/handlers/sdp/plainRtpUtils");
const SoupSDPU = require("mediasoup-client/lib/handlers/sdp/commonUtils");
const SoupORTCU = require("mediasoup-client/lib/ortc");

const C_PRODUCER = 'producer';
const C_CONSUMER = 'consumer';

const getRtcpParameters = (sdpObject, kind) => {
  const mediaLine = (sdpObject.media || []).find((m) => m.type === kind);

  if (!mediaLine) {
    throw new Error(`Section not found: ${kind}`);
  }

  const ssrcCname = (mediaLine.ssrcs || []).find(s => s.attribute && s.attribute === "cname");
  const cname = ssrcCname && ssrcCname.value ? ssrcCname.value : null;
  const reducedSize = "rtcpRsize" in mediaLine;

  return { cname: cname, reducedSize: reducedSize };
}

const extractSendRtpParams = (kind, caps) => {
  return SoupORTCU.getSendingRtpParameters(kind, caps);
};

const extractRTPParams = (baseRTPCaps, parsedSdp, kind) => {
  const caps = SoupSDPU.extractRtpCapabilities({
    sdpObject: parsedSdp,
  });

  const msExtendedRtpCaps = SoupORTCU.getExtendedRtpCapabilities(
    baseRTPCaps,
    caps
  );

  const sendRTPParams = extractSendRtpParams(kind, msExtendedRtpCaps);

  // TODO: "mid"
  //sendRTPParams.mid = '1';

  const encodings = SoupRTPU.getRtpEncodings({
    sdpObject: parsedSdp,
    kind,
  });

  sendRTPParams.encodings = encodings;

  // TODO proper RTCP fillers
  //sendRTPParams.rtcp = getRtcpParameters(parsedSdp, "video");

  return sendRTPParams;
}

const extractPlainRtpParameters = (parsedSdp, kind) => {
  return SoupRTPU.extractPlainRtpParameters({
    sdpObject: parsedSdp,
    kind,
  });
}

module.exports = {
  C_PRODUCER,
  C_CONSUMER,
  getRtcpParameters,
  extractRTPParams,
  extractPlainRtpParameters,
  extractSendRtpParams,
};
