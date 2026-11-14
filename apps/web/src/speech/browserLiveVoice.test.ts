import { expect, it, vi } from "vite-plus/test";
import { BrowserLiveVoice } from "./browserLiveVoice";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((success) => {
    resolve = success;
  });
  return { promise, resolve };
}

it("releases a microphone granted after the user cancels without opening a remote call", async () => {
  let grant!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    grant = resolve;
  });
  const stop = vi.fn();
  const open = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => permission } });
  vi.stubGlobal("RTCPeerConnection", vi.fn());
  try {
    const voice = new BrowserLiveVoice({
      open,
      poll: vi.fn(),
      stop: vi.fn(),
      onPhase: vi.fn(),
      onTranscript: vi.fn(),
    });
    const starting = voice.start("sol");
    voice.stop();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await starting;
    expect(stop).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does not request microphone access when cancelled while resolving the preferred device", async () => {
  let choose!: (id: string) => void;
  const preference = new Promise<string>((resolve) => {
    choose = resolve;
  });
  const capture = vi.fn();
  const open = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
  vi.stubGlobal("RTCPeerConnection", vi.fn());
  try {
    const voice = new BrowserLiveVoice({
      open,
      poll: vi.fn(),
      stop: vi.fn(),
      getMicrophoneId: () => preference,
      onPhase: vi.fn(),
      onTranscript: vi.fn(),
    });
    const starting = voice.start("aube");
    voice.stop();
    choose("preferred-device");
    await starting;
    expect(capture).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(["device selection", "microphone permission"] as const)(
  "keeps mute changes made while waiting for %s before attaching audio",
  async (pending) => {
    const selection = deferred<string>();
    const permission = deferred<MediaStream>();
    const capturing = deferred<void>();
    const attached = deferred<boolean>();
    const offer = deferred<RTCSessionDescriptionInit>();
    const track = { enabled: true, stop: vi.fn() };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(() => {
      capturing.resolve();
      return permission.promise;
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal(
      "RTCPeerConnection",
      class {
        iceGatheringState = "complete";
        addTrack(value: MediaStreamTrack) {
          attached.resolve(value.enabled);
        }
        createDataChannel() {}
        createOffer() {
          return offer.promise;
        }
        async setLocalDescription() {}
        addEventListener() {}
        removeEventListener() {}
        close() {}
      },
    );
    vi.stubGlobal(
      "Audio",
      class {
        pause() {}
      },
    );
    const voice = new BrowserLiveVoice({
      open: vi.fn(),
      poll: vi.fn(),
      stop: vi.fn(),
      getMicrophoneId: () => (pending === "device selection" ? selection.promise : ""),
      onPhase: vi.fn(),
      onTranscript: vi.fn(),
    });
    const starting = voice.start("aube");
    try {
      if (pending === "microphone permission") await capturing.promise;
      voice.mute(true);
      selection.resolve("preferred-device");
      await capturing.promise;
      permission.resolve(stream);
      expect(await attached.promise).toBe(false);
      voice.mute(false);
      expect(track.enabled).toBe(true);
      voice.mute(true);
      expect(track.enabled).toBe(false);
    } finally {
      voice.stop();
      offer.resolve({ type: "offer", sdp: "v=offer\r\n" });
      await starting;
      vi.unstubAllGlobals();
    }
    expect(track.stop).toHaveBeenCalledOnce();
  },
);
