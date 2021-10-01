const { RECORDER_FFMPEG } = require('./configs.js');

const REC_MIN_PORT = parseInt(RECORDER_FFMPEG.recMinPort);
const REC_MAX_PORT = parseInt(RECORDER_FFMPEG.recMaxPort);

const PORT_MAP = {};

const populate = () => {
  for (let i = REC_MIN_PORT; i <= REC_MAX_PORT; i++) {
    if ((i % 2) === 0) {
      PORT_MAP[i] = false;
    }
  }
};

const isVacant = (port) => {
  return PORT_MAP[port] !== undefined && PORT_MAP[port] === false;
};

const occupy = (port) => {
  if (PORT_MAP[port] === false) {
    PORT_MAP[port] = true;
    return;
  }

  throw new Error('Port is in use');
}

const release = (port) => {
  PORT_MAP[port] = false;
}

const getPort = () => {
  let found = false;
  let current = REC_MIN_PORT;

  while (!found && current <= REC_MAX_PORT) {
    if (isVacant(current)) {
      found = true;
    } else {
      current += 1;
    }
  }

  if (found) {
    occupy(current);
    return current;
  }

  throw new Error("Port range exhausted");
}

const getPortPair = () => {
  const rtp = getPort();

  return { rtp, rtcp: rtp + 1 }
}

const releasePortPair = (rtp) => {
  release(rtp);
}

populate();

module.exports = {
  getPortPair,
  releasePortPair,
}
