/* Nomi API room helpers. This module never stores or prints API credentials. */
const NOMI_API_BASE = 'https://api.nomi.ai/v1';
const NOMI_API_CHUNK_BYTES = 800;

function apiRoomId(roomUuid) { return 'api:room:' + roomUuid; }
function apiRoomUuid(id) {return String(id || '').startsWith('api:room:') ? String(id).slice(9) : '';}
function safeNomiId(id) {return typeof id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(id);}
function roomHasNomi(room, nomiUuid) {
  return ['nomiUuids','nomis'].some(k => Array.isArray(room?.[k]) &&
    room[k].some(n => (typeof n === 'string' ? n : n?.uuid) === nomiUuid));
}
function apiChunks(text, limit = NOMI_API_CHUNK_BYTES) {
  if (typeof text !== 'string' || !text.length) return [];
  if (!Number.isInteger(limit) || limit < 4) throw Error('Invalid UTF-8 chunk budget.');
  const encoder = new TextEncoder(), output = [];
  let start = 0;
  while (start < text.length) {
    let end = start, bytes = 0;
    for (const symbol of text.slice(start)) {
      const n = encoder.encode(symbol).length;
      if (bytes + n > limit) break;
      bytes += n;
      end += symbol.length; // Keeps UTF-16 surrogate pairs intact.
    }
    if (end === start) throw Error('Character exceeds API message budget.');
    if (end < text.length) {
      const section = text.slice(start,end);
      const boundary = Math.max(section.lastIndexOf('\n'),section.lastIndexOf(' '));
      // Prefer intact sentences/words, but never create very short chunks.
      if (boundary >= Math.floor(section.length * .75)) end = start + boundary + 1;
    }
    output.push(text.slice(start,end));
    start = end;
  }
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
