import { Platform } from "react-native";
import { File } from "expo-file-system";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import type { RecordingOptions } from "expo-audio";

/**
 * THE MICROPHONE, FOR ONE SPOKEN NOTE (decision 0048).
 *
 * Speech, not music: 16 kHz mono AAC at 32 kbit/s — sixty seconds is about 240 kB, inside the API's
 * own 1 MB request limit with room to spare. The clip is a file in the app's cache for the seconds
 * between Stop and the upload; `take()` reads it into memory and DELETES it, and a note the doctor
 * abandons is deleted by `discard()`. Nothing is kept on the phone, and the server keeps none either.
 */
export const VOICE_OPTIONS: RecordingOptions = {
  extension: ".m4a", sampleRate: 16000, numberOfChannels: 1, bitRate: 32000,
  android: { outputFormat: "mpeg4", audioEncoder: "aac" },
  ios: { outputFormat: "aac ", audioQuality: 64 },
  web: { mimeType: "audio/webm", bitsPerSecond: 32000 },
} as RecordingOptions;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Hermes has no Buffer; this is the whole of base64. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!
      + (b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!) + (c === undefined ? "=" : B64[c & 63]!);
  }
  return out;
}

export type Clip = { audio: string; mimeType: string; seconds: number };
export type VoiceRecorder = {
  /** Asks for the microphone if it has not been asked; false when the phone refuses. */
  allow(): Promise<boolean>;
  start(): Promise<void>;
  /** Stops, reads the clip into memory and deletes the file. Null when nothing usable was recorded. */
  take(seconds: number): Promise<Clip | null>;
  discard(): Promise<void>;
};

export function useVoiceRecorder(): VoiceRecorder {
  const rec = useAudioRecorder(VOICE_OPTIONS);
  const drop = async (uri: string | null): Promise<void> => {
    if (uri === null || Platform.OS === "web") return;
    try { new File(uri).delete(); } catch { /* the cache is the OS's to clear */ }
  };
  return {
    async allow() {
      const had = await getRecordingPermissionsAsync();
      if (had.granted) return true;
      if (!had.canAskAgain) return false;
      return (await requestRecordingPermissionsAsync()).granted;
    },
    async start() {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await rec.prepareToRecordAsync();
      rec.record();
    },
    async take(seconds) {
      await rec.stop();
      const uri = rec.uri;
      if (uri === null) return null;
      try {
        const buf = Platform.OS === "web" ? await (await fetch(uri)).arrayBuffer() : await new File(uri).arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (bytes.length === 0) return null;
        return { audio: toBase64(bytes), mimeType: Platform.OS === "web" ? "audio/webm" : "audio/mp4", seconds };
      } finally {
        await drop(uri);
        await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      }
    },
    async discard() {
      try { await rec.stop(); } catch { /* not recording */ }
      await drop(rec.uri);
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    },
  };
}
