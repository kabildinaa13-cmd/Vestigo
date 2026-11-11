export const UPLOAD_METADATA_HEADER = "x-vestigo-upload-metadata";
const fields = ["name", "caseId", "episodeId", "groupId", "typeId", "source", "receivedAt", "classificationMode", "processInBackground", "ownerId", "ownerAccount", "bankFeeMode", "defaultCurrency", "bankYear"];

export function encodeUploadMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Некорректные параметры загрузки");
  if (Object.keys(value).some(key => !fields.includes(key) || typeof value[key] !== "string" || value[key].length > 2000))
    throw new Error("Некорректные параметры загрузки");
  if (!value.name || value.name.length > 512 || !value.caseId || value.caseId.length > 100) throw new Error("Укажите файл и дело");
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
  if (encoded.length > 12288) throw new Error("Описание загрузки слишком длинное");
  return encoded;
}

export function decodeUploadMetadata(header) {
  if (!header || header.length > 12288 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) throw new Error("Некорректные параметры загрузки");
  try {
    const value = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(Uint8Array.from(atob(header), c => c.charCodeAt(0))));
    encodeUploadMetadata(value);
    return value;
  } catch { throw new Error("Некорректные параметры загрузки"); }
}
