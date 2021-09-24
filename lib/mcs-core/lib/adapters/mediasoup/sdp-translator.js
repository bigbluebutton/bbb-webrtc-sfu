'use strict';

const SoupRTPU = require("mediasoup-client/lib/handlers/sdp/plainRtpUtils");
const SoupSDPU = require("mediasoup-client/lib/handlers/sdp/commonUtils");
const SoupORTCU = require("mediasoup-client/lib/ortc");
const RemoteSdp = require("mediasoup-client/lib/handlers/sdp/RemoteSdp");

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

const extractRecvRTPParams = (extCaps) => {
  return SoupORTCU.getRecvRtpCapabilities(extCaps);
}

const extractRTPParams = (baseRTPCaps, jsonSdp, kind, mode) => {
  const caps = SoupSDPU.extractRtpCapabilities({
    sdpObject: jsonSdp,
  });

  const msExtendedRtpCaps = SoupORTCU.getExtendedRtpCapabilities(
    baseRTPCaps,
    caps
  );

  let params;

  if (mode === 'producer') {
    params = extractSendRtpParams(kind, msExtendedRtpCaps);
    const encodings = SoupRTPU.getRtpEncodings({
      sdpObject: jsonSdp,
      kind,
    });
    params.encodings = encodings;
  } else {
    params = extractRecvRTPParams(msExtendedRtpCaps);
  }

  return params;
}

const extractPlainRtpParameters = (jsonSdp, kind) => {
  return SoupRTPU.extractPlainRtpParameters({
    sdpObject: jsonSdp,
    kind,
  });
}

const _processHackFlags = (targetMediaSection, adapterOptions = {}) => {
  if (!!adapterOptions.msHackRTPAVPtoRTPAVPF) {
    targetMediaSection._mediaObject.protocol = targetMediaSection._mediaObject
      .protocol.replace(/RTP\/AVP/ig, 'RTP/AVPF');
  }
}

const _getMappedDirectionFromMType = (mediaTypes) => {
  if (mediaTypes.video == 'sendonly'
    || mediaTypes.content == 'sendonly'
    || mediaTypes.audio === 'sendonly') {
    return 'recvonly';
  }

  if (mediaTypes.video == 'recvonly'
    || mediaTypes.content == 'recvonly'
    || mediaTypes.audio === 'recvonly') {
    return'sendonly';
  }

  return 'sendrecv';
};

// This obviously only works for single stream SDPs right now.
// But then again: when we reach the point where we want to do proper bundling
// and use less transports, we won't use SDP. So who cares? -- prlanzarin
const assembleSDP = (mediaTypes, {
  transportOptions,
  kindParametersMap,
  adapterOptions,
}) => {
  const reassembledSDP = new RemoteSdp.RemoteSdp({
    ...transportOptions,
  });

  kindParametersMap.forEach((kMap, i) => {
    reassembledSDP.receive({
      mid: i,
      kind: kMap.actualMediaType,
      offerRtpParameters: kMap.offerRtpParameters,
      streamId: kMap.streamId,
      trackId: kMap.trackId,
    });

    const targetMediaSection = reassembledSDP._mediaSections.find(ms => ms._mediaObject.mid == i);
    if (targetMediaSection) {
      targetMediaSection._mediaObject.direction = _getMappedDirectionFromMType(mediaTypes);
      if (kMap.setup) { targetMediaSection._mediaObject.setup = kMap.setup; }
      _processHackFlags(targetMediaSection, adapterOptions);
    }
  });

  return reassembledSDP.getSdp();
};

module.exports = {
  getRtcpParameters,
  extractRTPParams,
  extractPlainRtpParameters,
  extractSendRtpParams,
  assembleSDP,
};
