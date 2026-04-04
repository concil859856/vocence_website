/**
 * Voice clone APIs typically expect WAV (PCM). Browser recording uses WebM/Opus — decode and re-encode as WAV.
 */

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const n = buffer.numberOfChannels;
  const len = buffer.length;
  if (n === 1) {
    return new Float32Array(buffer.getChannelData(0));
  }
  const out = new Float32Array(len);
  for (let c = 0; c < n; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) {
      out[i] += ch[i];
    }
  }
  for (let i = 0; i < len; i++) {
    out[i] /= n;
  }
  return out;
}

function encodeWav16BitMonoPcm(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bitsPerSample = 16;
  const numChannels = 1;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, Math.round(s * 0x7fff), true);
    offset += 2;
  }
  return buffer;
}

function isLikelyWav(blob: Blob): boolean {
  return blob.type.includes('wav') || blob.type.includes('wave');
}

/**
 * If the blob is not already WAV, decode via Web Audio and export mono 16-bit PCM WAV for the clone service.
 */
export async function blobToCloneReferenceWav(blob: Blob, filename = 'reference.wav'): Promise<File> {
  if (isLikelyWav(blob)) {
    return new File([blob], filename.replace(/\.[^.]+$/, '.wav'), { type: 'audio/wav' });
  }

  const raw = await blob.arrayBuffer();
  const copy = raw.slice(0);
  const ctx = new AudioContext();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(copy);
  } finally {
    await ctx.close();
  }

  const mono = mixToMono(audioBuffer);
  const wavBuffer = encodeWav16BitMonoPcm(mono, audioBuffer.sampleRate);
  return new File([wavBuffer], filename.endsWith('.wav') ? filename : `${filename.replace(/\.[^.]+$/, '')}.wav`, {
    type: 'audio/wav',
  });
}
