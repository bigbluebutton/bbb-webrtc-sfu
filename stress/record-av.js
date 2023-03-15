'use strict';

const { v4: uuidv4 }= require('uuid');
const {
  MCS_ROOM,
  MCS_USER_ID,
  MCS,
  join,
  generateAVPubOffer,
  processPubAnswer,
  encodeAV,
} = require('./common.js');

const record = async ({ mediaId: pubId }) => {
  const nativeOptions = {
    profiles: {
      audio: 'sendrecv',
      content: 'sendrecv',
    },
    mediaProfile: 'content',
    adapter: 'mediasoup',
    ignoreThresholds: true,
    adapterOptions: {
      transportOptions: {
        rtcpMux: false,
        comedia: false,
      },
      splitTransport: true,
      msHackRTPAVPtoRTPAVPF: true,
    }
  };

  const {  mediaId: nativeMediaId, answer: nativeDescriptor } = await MCS.subscribe(
    MCS_USER_ID, pubId, 'RtpEndpoint', nativeOptions,
  );

  const hgaOptions = {
    descriptor: nativeDescriptor,
    adapter: 'Kurento',
    ignoreThresholds: true,
    profiles: {
      audio: 'sendonly',
      content: 'sendonly',
    },
    mediaProfile: 'content',
    adapterOptions: {
      kurentoRemoveRembRtcpFb: true,
    }
  };

  const { mediaId: hgaMediaId, answer: hgaAnswer } = await MCS.publish(
    MCS_USER_ID, MCS_ROOM, 'RtpEndpoint', hgaOptions,
  );

  nativeOptions.descriptor = hgaAnswer;
  nativeOptions.mediaId = nativeMediaId;
  await MCS.subscribe(MCS_USER_ID, pubId, 'RtpEndpoint', nativeOptions);

  const filename = `/var/kurento/tmp/${uuidv4()}.webm`;
  //const filename = '/dev/null';
  await MCS.startRecording(
    MCS_USER_ID,
    hgaMediaId,
    filename,
    { recordingProfile: 'WEBM', ignoreThresholds: true, filename, mediaProfile: 'content' },
  );
}

join()
  .then(generateAVPubOffer)
  .then(encodeAV)
  .then(processPubAnswer)
  .then(record)
  .catch(console.error);
