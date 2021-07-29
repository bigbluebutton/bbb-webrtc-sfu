'use strict';

const C = require('../../constants/constants');
const { handleError } = require('./errors.js');

// MEDIA_ELEMENT_STORAGE: Map<elementId, MediaSoupElement>. Registers thin
// wrappers for Mediasoup citizens (a bundle of transports, consumers, publishers).
const MEDIA_ELEMENT_STORAGE = new Map();

const storeElement = (id, element) => {
  if (!element) return false;

  if (hasElement(id)) {
    // Might be an ID collision. Throw this peer out and let the client reconnect
    throw handleError({
      ...C.ERROR.MEDIA_ID_COLLISION,
      details: "MEDIASOUP_MEL_COLLISION"
    });
  }

  MEDIA_ELEMENT_STORAGE.set(id, element);

  return true;
}

const getElement = (id) => {
  return MEDIA_ELEMENT_STORAGE.get(id);
}

const hasElement = (id) => {
  return MEDIA_ELEMENT_STORAGE.has(id);
}

const deleteElement = (id) => {
  const element = getElement(id);
  if (element == null) return false;
  return MEDIA_ELEMENT_STORAGE.delete(id);
}

const getMediaElementId = (mediaElement) => {
  return mediaElement.id;
}

module.exports = {
  storeElement,
  getElement,
  hasElement,
  deleteElement,
  getMediaElementId,
}
