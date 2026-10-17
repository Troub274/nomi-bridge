/* Nomi API room helpers. This module never stores or prints API credentials. */
const NOMI_API_BASE = 'https://api.nomi.ai/v1';
const NOMI_API_CHUNK_BYTES = 750;

function apiRoomId(roomUuid) { return 'api:room:' + roomUuid; }
function apiRoomUuid(id) {return String(id || '').startsWith('api:room:') ? String(id).slice(9) : '';}
function safeNomiId(id) {return typeof id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(id);}
function roomHasNomi(room, nomiUuid) {
  return ['nomiUuids','nomis'].some(k => Array.isArray(room?.[k]) &&
    room[k].some(n => (typeof n === 'string' ? n : n?.uuid) === nomiUuid));
}
function apiChunks(text, limit = NOMI_API_CHUNK_BYTES) {
  if (typeof text !== 'string' || !text.length) return [];
  const encoder = new TextEncoder(), output = [];
  let buffer = '', used = 0;
  for (const symbol of text) {
    const bytes = encoder.encode(symbol).length;
    if (bytes > limit) throw Error('Character exceeds API message budget.');
    if (used + bytes > limit && buffer) {output.push(buffer); buffer = ''; used = 0;}
    buffer += symbol; used += bytes;
  }
  if (buffer) output.push(buffer);
  return output;
}
function nomiReplyText(payload) {
  const message = payload?.replyMessage;
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    for (const field of ['messageText','text','content']) {
      if (typeof message[field] === 'string' && message[field].trim()) return message[field];
    }
  }
  throw Error('Nomi API returned no replyMessage text. Inspect the room before retrying.');
}
function safeNomiError(status, payload) {
  const err = payload?.error;
  const type = typeof err?.type === 'string' ? err.type :
    typeof payload?.type === 'string' ? payload.type : 'ApiError';
  // Deliberately do not interpolate raw error bodies: servers can echo credentials or requests.
  return 'Nomi API ' + type.slice(0,80) + ' (HTTP ' + (status || 'network error') + ')';
}
const apiRoomHelpers = {NOMI_API_BASE,NOMI_API_CHUNK_BYTES,apiRoomId,apiRoomUuid,safeNomiId,roomHasNomi,apiChunks,nomiReplyText,safeNomiError};
if (typeof module !== 'undefined') module.exports = apiRoomHelpers;
else globalThis.NomiApiRoom = apiRoomHelpers;
