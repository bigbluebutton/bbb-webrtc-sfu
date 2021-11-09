'use strict';

const SoupRTPU = require("mediasoup-client/lib/handlers/sdp/plainRtpUtils");
const SoupSDPU = require("mediasoup-client/lib/handlers/sdp/commonUtils");
const SoupORTCU = require("mediasoup-client/lib/ortc");
const RemoteSdp = require("mediasoup-client/lib/handlers/sdp/RemoteSdp");
const transform = require('sdp-transform');

const extractPlainRtpParameters = (jsonSdp, kind, rtcpMux) => {
  const mediaSections = jsonSdp.media || [];
  // Presuming kinds are unitary...
  const mediaLine = mediaSections.find((m) => m.type === kind);
  // media line IP or top level IP
  const connectionData = mediaLine.connection || jsonSdp.connection;

  return {
    ip: connectionData.ip,
    ipVersion: connectionData.version,
    port: mediaLine.port,
    rtcpPort: (!rtcpMux && mediaLine.rtcp) ? mediaLine.rtcp.port : undefined,
  };
}

const getRtcpParameters = (jsonSdp, kind) => {
  let cname, reducedSize;
  const mediaSections = jsonSdp.media || [];
  // Presuming kinds are unitary...
  const mediaLine = mediaSections.find((m) => m.type === kind);
  if (mediaLine) {
    if (mediaLine.ssrcs) {
      const ssrcCname = mediaLine.ssrcs.find(s => s.attribute && s.attribute === "cname");
      if (ssrcCname && ssrcCname.value) {
        cname = ssrcCname.value;
      }
    }
    reducedSize = mediaLine.rtcpRsize === 'rtcp-rsize';
  }

  return { cname, reducedSize };
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

  params.rtcp = getRtcpParameters(jsonSdp, kind);

  return params;
}

const _processHackFlags = (targetMediaSection, adapterOptions = {}) => {
  if (adapterOptions.msHackRTPAVPtoRTPAVPF) {
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
      if (kMap.setup) {
        targetMediaSection._mediaObject.setup = kMap.setup;
      }

      // If rtcpPort is specified, it means no rtcp-mux and we are implying
      // no rsize as well
      if (transportOptions.plainRtpParameters && transportOptions.plainRtpParameters.rtcpPort) {
        if (targetMediaSection._mediaObject.rtcpMux) {
          targetMediaSection._mediaObject.rtcpMux = null;
        }

        if (targetMediaSection._mediaObject.rtcpRsize) {
          targetMediaSection._mediaObject.rtcpRsize = null;
        }

        if (targetMediaSection._mediaObject.rtcp == null) {
          targetMediaSection._mediaObject.rtcp = {};
        }

        targetMediaSection._mediaObject.rtcp.port = transportOptions.plainRtpParameters.rtcpPort;
      }

      _processHackFlags(targetMediaSection, adapterOptions);
    }
  });

  return reassembledSDP.getSdp();
};

const reassembleSDPObjectFromMediaLines = (jsonSdp, mediaLines) => {
  if (!mediaLines || mediaLines.length <= 0) return;
  const partialSDP = Object.assign({}, jsonSdp);
  partialSDP.media = mediaLines;
  return partialSDP;
};

const generateOneSDPObjectPerMediaType = (jsonSdp) => {
  const descriptorsWithMType = []

  if (jsonSdp && jsonSdp.media) {
    jsonSdp.media.forEach(media => {
      const partialSDPObject = reassembleSDPObjectFromMediaLines(jsonSdp, [media]);
      if (partialSDPObject) {
        descriptorsWithMType.push({ mediaType: media.type, descriptor: partialSDPObject });
      }
    });
  }

  return descriptorsWithMType;
}

const mergeSameSourceSDPs = (stringSdpArray) => {
  if (stringSdpArray == null || stringSdpArray.length === 0) return;
  if (stringSdpArray.length === 1) return stringSdpArray[1];

  const targetSDP = transform.parse(stringSdpArray.shift());

  stringSdpArray.forEach(sdp => {
    const sdpObject = transform.parse(sdp);
    if (sdpObject.media) {
      sdpObject.media.forEach(ml => {
        targetSDP.media.push(ml);
      })
    }
  });

  return transform.write(targetSDP);
}

const stringifySDP = (sdpObject) => {
  return transform.write(sdpObject);
}

module.exports = {
  assembleSDP,
  getRtcpParameters,
  extractRTPParams,
  extractPlainRtpParameters,
  extractSendRtpParams,
  generateOneSDPObjectPerMediaType,
  mergeSameSourceSDPs,
  stringifySDP,
};
