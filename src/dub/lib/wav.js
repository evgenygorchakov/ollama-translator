// Длительность wav по заголовку: байт в секунду — из чанка "fmt ", объём звука — из "data".

function tag(bytes, offset) {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

// buffer — ArrayBuffer с wav. → секунды; не wav — бросает Error.
export function wavDuration(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 12 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") {
    throw new Error("Это не wav: нет заголовка RIFF/WAVE");
  }
  let byteRate = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = tag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) {
      byteRate = view.getUint32(body + 8, true);
    } else if (id === "data") {
      if (!byteRate) throw new Error("В wav нет формата звука до данных");
      // размер может быть больше файла: обрезанный файл или запись потоком (0xFFFFFFFF)
      return Math.min(size, bytes.length - body) / byteRate;
    }
    offset = body + size + (size & 1); // чанки выровнены по чётному байту
  }
  throw new Error("В wav нет звука (чанка data)");
}
