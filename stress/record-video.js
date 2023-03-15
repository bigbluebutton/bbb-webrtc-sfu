'use strict';

const { v4: uuidv4 }= require('uuid');
const {
  MCS_ROOM,
  MCS_USER_ID,
  MCS,
  join,
  generateVideoPubOffer,
  processPubAnswer,
  encodeVideo,
} = require('./common.js');

const record = async ({ mediaId: pubId }) => {
  const nativeOptions = {
    profiles: {
      video: 'sendrecv',
    },
    mediaProfile: 'main',
    adapter: 'mediasoup',
    ignoreThresholds: true,
    adapterOptions: {
      transportOptions: {
        rtcpMux: false,
        comedia: false,
      },
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
      video: 'sendonly',
    },
    mediaProfile: 'main',
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
    { recordingProfile: 'WEBM_VIDEO_ONLY', ignoreThresholds: true, filename },
  );
}

join()
  .then(generateVideoPubOffer)
  .then(encodeVideo)
  .then(processPubAnswer)
  .then(record)
  .catch(console.error);
